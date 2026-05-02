// routes/webhook.js
// ⚠️  Ce fichier doit être enregistré AVANT app.use(express.json()) dans index.js.
//     Stripe exige le body brut (Buffer) pour valider la signature HMAC.
//     express.json() parserait le body avant qu'on puisse le lire comme Buffer → signature invalide.

const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { processStripeSession } = require('../services/stripeProcessor');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── POST /api/webhook/stripe ──────────────────────────────────────────────────
// Événement ciblé : checkout.session.completed
//
// Ce webhook est le filet de sécurité pour les cas où le client paie mais
// ferme l'onglet AVANT d'être redirigé vers /succes.
// Sans ce webhook, le paiement serait encaissé mais la réservation n'existerait pas.
//
// Idempotence garantie par la table stripe_payments (même logique que confirm-booking).
// Les deux chemins (redirect + webhook) peuvent arriver dans n'importe quel ordre.

router.post(
  '/api/webhook/stripe',
  express.raw({ type: 'application/json' }), // ← body brut obligatoire pour Stripe
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error('❌ STRIPE_WEBHOOK_SECRET non défini — webhook désactivé.');
      return res.status(500).json({ error: 'Webhook secret manquant' });
    }

    // ── Vérification de la signature ─────────────────────────────────────────
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('❌ Signature webhook invalide :', err.message);
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    // ── On répond immédiatement 200 à Stripe ────────────────────────────────
    // Stripe re-tentera l'envoi si on ne répond pas sous 30s.
    // On fait le traitement réel juste après.
    res.json({ received: true });

    // ── Traitement de l'événement ────────────────────────────────────────────
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // On ignore les sessions non payées (ex: payment_intent pending pour virement)
      if (session.payment_status !== 'paid') {
        console.log(`⏭️  Session ${session.id} ignorée (payment_status: ${session.payment_status})`);
        return;
      }

      // On ignore aussi les sessions gratuites (traitées synchroniquement en amont)
      if (session.id.startsWith('GRATUIT_')) return;

      try {
        const result = await processStripeSession(session);
        if (result === null) {
          // Déjà traité par confirm-booking → normal, rien à faire
          console.log(`ℹ️  Webhook checkout.session.completed ignoré (déjà traité) : ${session.id}`);
        }
      } catch (err) {
        // On ne peut plus renvoyer d'erreur HTTP (réponse déjà envoyée).
        // Stripe retentera automatiquement si on avait renvoyé un 5xx,
        // mais ici on a déjà dit 200. On log l'erreur pour investigation manuelle.
        console.error(`❌ ERREUR CRITIQUE dans le traitement webhook ${session.id} :`, err.message);
        // TODO: Sentry.captureException(err, { extra: { session_id: session.id } });
      }
    }
  }
);

module.exports = router;
