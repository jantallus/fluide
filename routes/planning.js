const express = require('express');
const router = express.Router();
const db = require('../db');
const { pool } = db;
const { authenticateUser, authenticateAdmin } = require('../middleware/auth');
const { googleSyncCache } = require('../services/googleSync');
const { notifyGoogleCalendar } = require('../services/email');

// Lit les créneaux Google occupés depuis le cache (chargé par googleSync.js toutes les 2 min)
async function getGoogleBusySlots(monitorName, webhookUrl) {
  const monRes = await pool.query(
    "SELECT id FROM users WHERE first_name = $1 AND is_active_monitor = true LIMIT 1",
    [monitorName]
  );
  if (monRes.rows.length === 0) return [];

  const cached = googleSyncCache.get(monRes.rows[0].id);
  if (cached && Array.isArray(cached)) {
    return cached.map(g => ({ start: new Date(g.start).getTime(), end: new Date(g.end).getTime() }));
  }

  try {
    const url = webhookUrl + '?monitorName=' + encodeURIComponent(monitorName);
    const resp = await fetch(url);
    const slots = await resp.json();
    return Array.isArray(slots) ? slots.map(g => ({ start: new Date(g.start).getTime(), end: new Date(g.end).getTime() })) : [];
  } catch (e) {
    return [];
  }
}

router.get('/api/slots', authenticateUser, async (req, res) => {
  try {
    const { start, end } = req.query;
    let query = 'SELECT * FROM slots WHERE 1=1';
    let params = [];

    if (req.user.role === 'monitor') {
      params.push(req.user.id);
      query += ` AND monitor_id = $${params.length}`;
    }

    if (start && end) {
      params.push(start, end);
      query += ` AND start_time >= $${params.length - 1} AND start_time <= $${params.length}`;
    } else {
      query += ` AND start_time >= NOW() - INTERVAL '1 month' AND start_time <= NOW() + INTERVAL '6 months'`;
    }

    query += ' ORDER BY start_time ASC';
    const r = await pool.query(query, params);
    let slots = r.rows;

    // 🎯 VÉRIFICATION: Le partage Google est-il activé ?
    const syncSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
    const isGoogleSyncEnabled = syncSetting.rows.length > 0 && syncSetting.rows[0].value === 'true';

    if (isGoogleSyncEnabled) {
      // 🎯 SYNC GOOGLE : Version ultra-rapide avec Cache
      const webhookUrl = process.env.GOOGLE_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbwRlzxV3bb1vIAnDiY0qz4YJGzPDwHu9qoABxaf5Q89lljHpf7rCP9hclWdoFF44L2j/exec";
      const monitorIds = [...new Set(slots.map(s => s.monitor_id).filter(id => id != null))];
      
      await Promise.all(monitorIds.map(async (mId) => {
        try {
          const monRes = await pool.query('SELECT first_name FROM users WHERE id = $1', [mId]);
          if (monRes.rows.length > 0) {
            const mName = monRes.rows[0].first_name;
            const googleBusySlots = await getGoogleBusySlots(mName, webhookUrl);

            slots = slots.map(slot => {
              const slotStart = new Date(slot.start_time).getTime();
              const slotEnd = new Date(slot.end_time).getTime();
              const isBusy = googleBusySlots.some(g => slotStart < g.end && slotEnd > g.start);
              if (slot.monitor_id === mId && isBusy && slot.status === 'available') {
                return { ...slot, status: 'booked', title: '🚫 BLOQUÉ (Google)', notes: 'Indisponibilité notée sur l\'agenda perso' };
              }
              return slot;
            });
          }
        } catch (e) { console.error(`Erreur sync Google pour ${mId}`); }
      }));
    }

    res.json(slots);
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

router.patch('/api/slots/:id', authenticateUser, async (req, res) => {
  let { title, weight, flight_type_id, notes, status, monitor_id, phone, email, weightChecked, booking_options, client_message } = req.body;
  const slotId = req.params.id;

  try {
    if (req.user.role === 'monitor') {
      return res.status(403).json({ error: "Mode lecture seule : Vous ne pouvez pas modifier le planning." });
    }

    if (req.user.role === 'permanent') {
      const checkRes = await pool.query('SELECT monitor_id, title, status FROM slots WHERE id = $1', [slotId]);
      if (checkRes.rows.length > 0) {
        const slot = checkRes.rows[0];
        if (slot.monitor_id !== req.user.id) {
          return res.status(403).json({ error: "Vous ne pouvez agir que sur votre propre planning." });
        }
        const isClientSlot = slot.status === 'booked' && slot.title && !['NOTE', '☕ PAUSE', 'NON DISPO'].some(t => slot.title.includes(t)) && !slot.title.includes('❌');
        const isMakingClientSlot = status === 'booked' && title && !['NOTE', '☕ PAUSE', 'NON DISPO'].some(t => title.includes(t)) && !title.includes('❌');
        if (isClientSlot || isMakingClientSlot) {
          return res.status(403).json({ error: "Les moniteurs permanents ne peuvent pas modifier les réservations clients." });
        }
        if (slot.title && slot.title.includes('(Admin)')) {
          return res.status(403).json({ error: "Action refusée : Ce créneau est verrouillé par la Direction." });
        }
      }
    }

    if (req.user.role === 'admin' && (title === 'NON DISPO' || title === '☕ PAUSE')) {
      title = `${title} (Admin)`;
    }

    const result = await pool.query(
      `UPDATE slots
      SET title = $1, weight = $2, flight_type_id = $3, notes = $4, status = $5,
          monitor_id = COALESCE($6, monitor_id), phone = $8, email = $9, weight_checked = $10,
          booking_options = $11, client_message = $12,
          payment_data = COALESCE($13, payment_data)
      WHERE id = $7 RETURNING *`,
      [
        title !== undefined ? title : null, weight ? parseInt(weight) : null, flight_type_id ? parseInt(flight_type_id) : null,
        notes !== undefined ? notes : null, status || 'available', monitor_id ? parseInt(monitor_id) : null, slotId,
        phone !== undefined ? phone : null, email !== undefined ? email : null, weightChecked !== undefined ? weightChecked : false,
        booking_options !== undefined ? booking_options : null, client_message !== undefined ? client_message : null,
        req.body.payment_data !== undefined ? JSON.stringify(req.body.payment_data) : null
      ]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Créneau introuvable" });
    
    const updatedSlot = result.rows[0];

    // 🎯 SYNC GOOGLE : Envoi des réservations manuelles depuis le backoffice
    // On vérifie que c'est une vraie réservation client
    if (updatedSlot.status === 'booked' && updatedSlot.title && 
        !['NOTE', '☕ PAUSE', 'NON DISPO'].some(t => updatedSlot.title.includes(t)) && 
        !updatedSlot.title.includes('❌') && 
        !updatedSlot.title.startsWith('↪️ Suite')) {
      
      try {
        // 🎯 L'INTERRUPTEUR EST ICI : On vérifie si la synchro est activée en base de données
        const syncSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
        if (syncSetting.rows.length > 0 && syncSetting.rows[0].value === 'true') {
          
          const monRes = await pool.query('SELECT first_name FROM users WHERE id = $1', [updatedSlot.monitor_id]);
          if (monRes.rows.length > 0) {
            const monitorName = monRes.rows[0].first_name;

            let desc = "Créé depuis le backoffice\n";
            if (updatedSlot.phone) desc += `Tel: ${updatedSlot.phone}\n`;
            if (updatedSlot.booking_options) desc += `Options: ${updatedSlot.booking_options}\n`;
            if (updatedSlot.notes) desc += `Notes internes: ${updatedSlot.notes}\n`;
            if (updatedSlot.client_message) desc += `Message client: ${updatedSlot.client_message}\n`;

            notifyGoogleCalendar(monitorName, updatedSlot.title, updatedSlot.start_time, updatedSlot.end_time, desc);
          }
        }
      } catch(e) { console.error("Erreur Synchro Google Admin:", e); }
    }

    res.json(updatedSlot);

  } catch (err) {
    console.error("ERREUR PATCH SLOT:", err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/slots/:id/quick', authenticateUser, async (req, res) => {
  const { payment_data, monitor_id } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const currentSlotRes = await client.query('SELECT * FROM slots WHERE id = $1', [req.params.id]);
    if (currentSlotRes.rows.length === 0) throw new Error("Créneau introuvable");
    const currentSlot = currentSlotRes.rows[0];

    if (payment_data !== undefined) {
      await client.query('UPDATE slots SET payment_data = $1 WHERE id = $2', [payment_data ? JSON.stringify(payment_data) : null, req.params.id]);
    }

    if (monitor_id !== undefined) {
       const targetMonitor = monitor_id || null;
       if (targetMonitor && targetMonitor !== currentSlot.monitor_id) {
         const targetSlotRes = await client.query('SELECT * FROM slots WHERE monitor_id = $1 AND start_time = $2', [targetMonitor, currentSlot.start_time]);
         if (targetSlotRes.rows.length > 0) {
            const targetSlot = targetSlotRes.rows[0];
            if (targetSlot.status !== 'available' && targetSlot.title !== 'NOTE') {
               throw new Error("Ce pilote a déjà un vol prévu à cette heure-là !");
            }
            await client.query('UPDATE slots SET monitor_id = NULL WHERE id = $1', [targetSlot.id]);
            await client.query('UPDATE slots SET monitor_id = $1 WHERE id = $2', [targetMonitor, currentSlot.id]);
            await client.query('UPDATE slots SET monitor_id = $1 WHERE id = $2', [currentSlot.monitor_id, targetSlot.id]);
         } else {
            await client.query('UPDATE slots SET monitor_id = $1 WHERE id = $2', [targetMonitor, currentSlot.id]);
         }
       } else if (!targetMonitor) {
         await client.query('UPDATE slots SET monitor_id = NULL WHERE id = $1', [currentSlot.id]);
       }
    }

    await client.query('COMMIT');
    const finalSlot = await client.query('SELECT * FROM slots WHERE id = $1', [req.params.id]);
    res.json(finalSlot.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message }); 
  } finally {
    client.release();
  }
});

router.post('/api/generate-slots', authenticateAdmin, async (req, res) => {
  const { startDate, endDate, daysToApply, plan_name, monitor_id, forceOverwrite } = req.body;
  const plan = plan_name || 'Standard';
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    let monitorFilterDelete = '';
    let monitorFilterSelect = '';
    const paramsSelect = [];
    const paramsDelete = [startDate, endDate];

    if (monitor_id && monitor_id !== 'all') {
        monitorFilterDelete = ' AND monitor_id = $3';
        paramsDelete.push(monitor_id);
        monitorFilterSelect = ' AND id = $1';
        paramsSelect.push(monitor_id);
    }

    if (!forceOverwrite) {
        const checkQuery = `
          SELECT COUNT(*) FROM slots 
          WHERE start_time::date >= $1 
          AND start_time::date <= $2 
          AND ((title IS NOT NULL AND title != '' AND title != '☕ PAUSE') OR (notes IS NOT NULL AND trim(notes) != ''))
          ${monitorFilterDelete}
        `;
        const check = await client.query(checkQuery, paramsDelete);
        if (parseInt(check.rows[0].count) > 0) {
            await client.query('ROLLBACK'); 
            return res.status(409).json({
                warning: true,
                message: `⚠️ ATTENTION : Il y a ${check.rows[0].count} réservation(s) ou note(s) importante(s) sur cette période. Voulez-vous VRAIMENT tout écraser ?`
            });
        }
    }
    
    await client.query(`DELETE FROM slots WHERE start_time::date >= $1 AND start_time::date <= $2 ${monitorFilterDelete}`, paramsDelete);
    
    const defs = await client.query("SELECT * FROM slot_definitions WHERE COALESCE(plan_name, 'Standard') = $1", [plan]);
    const mons = await client.query(`SELECT id, available_start_date, available_end_date, daily_start_time, daily_end_time FROM users WHERE is_active_monitor = true AND status = 'Actif' ${monitorFilterSelect}`, paramsSelect);
    
    // Chargement unique des disponibilités moniteurs (évite N requêtes dans la boucle)
    const availsResult = await client.query('SELECT * FROM monitor_availabilities');
    const availsByMonitor = {};
    for (const a of availsResult.rows) {
      if (!availsByMonitor[a.user_id]) availsByMonitor[a.user_id] = [];
      availsByMonitor[a.user_id].push(a);
    }

    let curr = new Date(startDate);
    const last = new Date(endDate);
    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    while (curr <= last) {
      const activeDays = daysToApply.map(Number);
      if (activeDays.includes(curr.getDay())) {
        const dateStr = curr.getFullYear() + '-' + String(curr.getMonth() + 1).padStart(2, '0') + '-' + String(curr.getDate()).padStart(2, '0');
        
        for (const d of defs.rows) {
          for (const m of mons.rows) {
            const startTS = `${dateStr} ${d.start_time}`;
            const isPause = (d.label === 'PAUSE' || d.label === '☕ PAUSE');
            
            const monitorAvails = availsByMonitor[m.id] || [];
            const avails = { rows: monitorAvails };
              const isAuthorized = avails.rows.some(a => {
                const startD = new Date(a.start_date);
                const endD = new Date(a.end_date);
                return curr >= startD && curr <= endD && (!a.daily_start_time || d.start_time >= a.daily_start_time) && (!a.daily_end_time || d.start_time < a.daily_end_time);
              });

              if (avails.rows.length > 0 && !isAuthorized) continue;
              
              placeholders.push(`($${paramIndex}, $${paramIndex+1}::timestamp, $${paramIndex+1}::timestamp + ($${paramIndex+2} || ' minutes')::interval, $${paramIndex+3}, $${paramIndex+4})`);
              values.push(m.id, startTS, d.duration_minutes, isPause ? 'booked' : 'available', isPause ? '☕ PAUSE' : null);
              paramIndex += 5; 
            }
          }
      }
      curr.setDate(curr.getDate() + 1);
    }

    if (placeholders.length > 0) {
      await client.query(`INSERT INTO slots (monitor_id, start_time, end_time, status, title) VALUES ${placeholders.join(', ')}`, values);
    }

    await client.query('COMMIT');
    res.json({ success: true, count: placeholders.length });
    
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { 
    client.release(); 
  }
});

router.get('/api/slot-definitions', async (req, res) => {
  try {
    const { plan } = req.query;
    const query = plan ? 'SELECT * FROM slot_definitions WHERE plan_name = $1 ORDER BY start_time' : 'SELECT * FROM slot_definitions ORDER BY start_time';
    const result = await pool.query(query, plan ? [plan] : []);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/slot-definitions', authenticateAdmin, async (req, res) => {
  try {
    const { start_time, duration_minutes, label, plan_name } = req.body;
    const r = await pool.query(
      `INSERT INTO slot_definitions (start_time, duration_minutes, label, plan_name) VALUES ($1, $2, $3, $4) RETURNING *`,
      [start_time, duration_minutes, label, plan_name || 'Standard']
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/api/slot-definitions/:id', authenticateAdmin, async (req, res) => {
  const { start_time, duration_minutes, label, plan_name } = req.body;
  try {
    await pool.query('UPDATE slot_definitions SET start_time = $1, duration_minutes = $2, label = $3, plan_name = $4 WHERE id = $5', [start_time, duration_minutes, label, plan_name || 'Standard', req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/api/slot-definitions/:id', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM slot_definitions WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/api/plans/:oldName', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE slot_definitions SET plan_name = $1 WHERE plan_name = $2', [req.body.newName, req.params.oldName]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/api/plans/:name', authenticateAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM slot_definitions WHERE plan_name = $1', [req.params.name]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


router.delete('/api/slots/:id', authenticateUser, async (req, res) => {
  try {
    // On récupère le code cadeau avant de vider le créneau
    const slotRes = await pool.query('SELECT payment_data FROM slots WHERE id = $1', [req.params.id]);
    if (slotRes.rows.length > 0 && slotRes.rows[0].payment_data) {
      const pd = slotRes.rows[0].payment_data;
      if (pd.code && pd.code_type === 'gift_card') {
        await pool.query(`DELETE FROM gift_cards WHERE UPPER(code) = $1 AND type = 'gift_card'`, [pd.code.toUpperCase()]);
      }
    }

    // Le nettoyage du créneau
    await pool.query(
      `UPDATE slots SET status = 'available', payment_data = NULL, title = NULL, notes = NULL, phone = NULL, email = NULL, booking_options = NULL, client_message = NULL, flight_type_id = NULL, weight_checked = false, weight = NULL WHERE id = $1`, [req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


module.exports = router;
