// services/sentry.js — Reporter Sentry léger (sans SDK lourd)
// Envoie les erreurs directement à l'API HTTP de Sentry.
// Aucune dépendance npm — pas de problème de build sur Railway.
// No-op complet si SENTRY_DSN n'est pas défini.

let sentryConfig = null;

function initSentry() {
  if (!process.env.SENTRY_DSN) {
    console.log('ℹ️  Sentry désactivé (SENTRY_DSN non défini).');
    return;
  }

  try {
    const url = new URL(process.env.SENTRY_DSN);
    sentryConfig = {
      key: url.username,
      host: url.hostname,
      projectId: url.pathname.replace('/', ''),
      environment: process.env.NODE_ENV || 'production',
    };
    console.log('✅ Sentry initialisé (reporting HTTP actif).');
  } catch (e) {
    console.error('❌ SENTRY_DSN invalide — Sentry désactivé :', e.message);
  }
}

/**
 * Capture une exception et l'envoie à Sentry via HTTP.
 * No-op si Sentry n'est pas configuré.
 * @param {Error} err
 * @param {{ extra?: object, tags?: object }} [context]
 */
async function captureException(err, context = {}) {
  if (!sentryConfig) return;

  const { key, host, projectId, environment } = sentryConfig;

  const payload = {
    platform: 'node',
    environment,
    level: 'error',
    timestamp: new Date().toISOString(),
    exception: {
      values: [
        {
          type: err?.name || 'Error',
          value: err?.message || String(err),
          stacktrace: {
            frames: parseStack(err?.stack),
          },
        },
      ],
    },
    ...(context.extra ? { extra: context.extra } : {}),
    ...(context.tags ? { tags: context.tags } : {}),
  };

  try {
    const sentryUrl = `https://${host}/api/${projectId}/store/`;
    const authHeader = `Sentry sentry_version=7, sentry_key=${key}, sentry_client=fluide-backend/1.0`;

    // Node 18+ a fetch natif — pas besoin de node-fetch
    await fetch(sentryUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': authHeader,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // Ne jamais planter à cause de Sentry lui-même
    console.warn('⚠️  Sentry : échec d\'envoi silencieux :', e.message);
  }
}

/**
 * Middleware Express — capture les erreurs passées à next(err) et les envoie à Sentry.
 * Usage : app.use(sentryErrorMiddleware) APRÈS toutes les routes.
 */
function sentryErrorMiddleware(err, req, res, next) {
  captureException(err, {
    tags: { boundary: 'express' },
    extra: {
      method: req.method,
      url: req.url,
    },
  }).catch(() => {}); // fire-and-forget
  next(err);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseStack(stack) {
  if (!stack) return [];
  return stack
    .split('\n')
    .slice(1)
    .map((line) => {
      const match = line.trim().match(/at (.+?) \((.+?):(\d+):(\d+)\)/);
      if (match) {
        return {
          function: match[1],
          filename: match[2],
          lineno: parseInt(match[3]),
          colno: parseInt(match[4]),
          in_app: !match[2].includes('node_modules'),
        };
      }
      return { filename: line.trim() };
    })
    .filter(Boolean)
    .reverse(); // Sentry attend les frames du plus ancien au plus récent
}

module.exports = { initSentry, captureException, sentryErrorMiddleware };
