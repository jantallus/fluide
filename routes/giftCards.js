const express = require('express');
const router = express.Router();
const db = require('../db');
const { pool } = db;
const { authenticateUser, authenticateAdmin } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');
const { generatePDFBuffer } = require('../services/pdf');
const { sendConfirmationEmail } = require('../services/email');

const giftCardLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 20,
  message: { error: 'Trop de tentatives. Réessayez dans 10 minutes.' },
  standardHeaders: true, legacyHeaders: false,
});

router.get('/api/gift-card-templates', async (req, res) => {
  const { publicOnly } = req.query;
  try {
    let query = `SELECT gct.*, ft.name as flight_name FROM gift_card_templates gct LEFT JOIN flight_types ft ON gct.flight_type_id = ft.id`;
    if (publicOnly === 'true') query += ` WHERE gct.is_published = true ORDER BY gct.price_cents ASC`;
    else query += ` ORDER BY gct.id DESC`;
    const r = await pool.query(query);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/gift-card-templates', authenticateAdmin, async (req, res) => {
  const { 
    title, description, price_cents, flight_type_id, validity_months, 
    image_url, is_published, pdf_background_url, popup_content, 
    show_popup, custom_line_1, custom_line_2, custom_line_3 
  } = req.body;

  try {
    const r = await pool.query(
      `INSERT INTO gift_card_templates (
        title, description, price_cents, flight_type_id, validity_months, 
        image_url, is_published, pdf_background_url, popup_content, 
        show_popup, custom_line_1, custom_line_2, custom_line_3
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        title, description, price_cents, flight_type_id || null, validity_months || 12, 
        image_url || null, is_published || false, pdf_background_url || null, 
        popup_content || null, show_popup || false, custom_line_1 || null, custom_line_2 || null, custom_line_3 || null
      ]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/api/gift-card-templates/:id', authenticateAdmin, async (req, res) => {
  const { 
    title, description, price_cents, flight_type_id, validity_months, 
    image_url, is_published, pdf_background_url, popup_content, 
    show_popup, custom_line_1, custom_line_2, custom_line_3 
  } = req.body;

  try {
    await pool.query(
      `UPDATE gift_card_templates SET 
        title = $1, description = $2, price_cents = $3, flight_type_id = $4, 
        validity_months = $5, image_url = $6, is_published = $7, 
        pdf_background_url = $8, popup_content = $9, show_popup = $10, 
        custom_line_1 = $11, custom_line_2 = $12, custom_line_3 = $13 
      WHERE id = $14`,
      [
        title, description, price_cents, flight_type_id || null, validity_months || 12, 
        image_url || null, is_published || false, pdf_background_url || null, 
        popup_content || null, show_popup || false, custom_line_1 || null, 
        custom_line_2 || null, custom_line_3 || null, req.params.id
      ]
    );
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

router.delete('/api/gift-card-templates/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM gift_card_templates WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


router.get('/api/gift-cards', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT gc.*, ft.name as flight_name FROM gift_cards gc LEFT JOIN flight_types ft ON gc.flight_type_id = ft.id ORDER BY gc.created_at DESC`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 🎯 1. CRÉATION D'UN CODE
// 🎯 1. CRÉATION D'UN CODE
router.post('/api/gift-cards', authenticateAdmin, async (req, res) => {
  const { flight_type_id, buyer_name, beneficiary_name, price_paid_cents, notes, type, discount_type, discount_value, custom_code, max_uses, valid_from, valid_until, discount_scope, is_partner, partner_amount_cents, partner_billing_type } = req.body;
  try {
    const finalCode = custom_code ? custom_code.toUpperCase().replace(/\s+/g, '-') : `FLUIDE-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    const r = await pool.query(
      `INSERT INTO gift_cards (code, flight_type_id, buyer_name, beneficiary_name, price_paid_cents, notes, type, discount_type, discount_value, max_uses, valid_from, valid_until, status, discount_scope, is_partner, partner_amount_cents, partner_billing_type) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'valid', $13, $14, $15, $16) RETURNING *`,
      [finalCode, flight_type_id || null, buyer_name || null, beneficiary_name || null, price_paid_cents || 0, notes || '', type || 'gift_card', discount_type || null, discount_value || null, max_uses || null, valid_from || null, valid_until || null, discount_scope || 'both', is_partner || false, partner_amount_cents || null, partner_billing_type || 'fixed']
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: "Ce code personnalisé existe déjà." });
    res.status(500).json({ error: err.message });
  }
});

// 🎯 2. MODIFICATION D'UN CODE
router.put('/api/gift-cards/:id', authenticateAdmin, async (req, res) => {
  const { flight_type_id, buyer_name, beneficiary_name, price_paid_cents, notes, discount_type, discount_value, max_uses, valid_from, valid_until, discount_scope, is_partner, partner_amount_cents, partner_billing_type } = req.body;
  try {
    await pool.query(
      `UPDATE gift_cards SET flight_type_id = $1, buyer_name = $2, beneficiary_name = $3, price_paid_cents = $4, notes = $5, discount_type = $6, discount_value = $7, max_uses = $8, valid_from = $9, valid_until = $10, discount_scope = $11, is_partner = $12, partner_amount_cents = $13, partner_billing_type = $14 WHERE id = $15`,
      [flight_type_id || null, buyer_name || null, beneficiary_name || null, price_paid_cents || 0, notes || '', discount_type || null, discount_value || null, max_uses || null, valid_from || null, valid_until || null, discount_scope || 'both', is_partner || false, partner_amount_cents || null, partner_billing_type || 'fixed', req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/api/gift-cards/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE gift_cards SET status = $1 WHERE id = $2`, [req.body.status, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/api/gift-cards/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM gift_cards WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/api/gift-cards/check/:code', giftCardLimiter, async (req, res) => {
  try {
    const r = await pool.query(`SELECT gc.*, ft.name as flight_name FROM gift_cards gc LEFT JOIN flight_types ft ON gc.flight_type_id = ft.id WHERE UPPER(gc.code) = UPPER($1) AND gc.status = 'valid'`, [req.params.code]);
    if (r.rows.length === 0) return res.status(404).json({ message: "Bon invalide ou déjà utilisé" });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


module.exports = router;
