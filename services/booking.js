const { notifyGoogleCalendar } = require('./email');

async function performBooking(client, contact, passengers, paymentData = null, billingInfo = null) {
  const groupId = billingInfo?.group_id || null;
  const billingName = billingInfo?.billing_name || null;
  const billingEmail = billingInfo?.billing_email || null;

  for (const p of passengers) {
    const flightRes = await client.query('SELECT * FROM flight_types WHERE id = $1', [p.flightId]);
    const flight = flightRes.rows[0];
    const flightDur = flight.duration_minutes || 15;

    const slotsRes = await client.query(`SELECT * FROM slots WHERE start_time::date = $1 AND status = 'available' ORDER BY start_time ASC FOR UPDATE`, [p.date]);
    const availableSlots = slotsRes.rows;
    let baseDur = 15;
    if (availableSlots.length > 0) {
      const s1 = new Date(availableSlots[0].start_time).getTime();
      const e1 = new Date(availableSlots[0].end_time).getTime();
      baseDur = Math.round((e1 - s1) / 60000) || 15;
    }
    const slotsNeeded = Math.ceil(flightDur / baseDur);

    const monSchedules = {};
    availableSlots.forEach(s => {
      if (!monSchedules[s.monitor_id]) monSchedules[s.monitor_id] = [];
      monSchedules[s.monitor_id].push(s);
    });

    let chosenMonitor = null;
    let slotsToBook = [];

    for (const monId of Object.keys(monSchedules)) {
      const monSlots = monSchedules[monId].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
      let startIndex = -1;
      for (let i = 0; i < monSlots.length; i++) {
        const tStr = new Date(monSlots[i].start_time).toLocaleTimeString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false });
        if (tStr === p.time) { startIndex = i; break; }
      }
      if (startIndex !== -1 && startIndex + slotsNeeded <= monSlots.length) {
        let isValid = true;
        let sequence = [monSlots[startIndex]];
        for (let i = 1; i < slotsNeeded; i++) {
          const prevEnd = new Date(monSlots[startIndex + i - 1].end_time).getTime();
          const currStart = new Date(monSlots[startIndex + i].start_time).getTime();
          if (Math.abs(currStart - prevEnd) > 60000) { isValid = false; break; }
          sequence.push(monSlots[startIndex + i]);
        }
        if (isValid) { chosenMonitor = monId; slotsToBook = sequence; break; }
      }
    }

    if (!chosenMonitor) throw new Error(`Plus de moniteur dispo pour ${p.firstName} à ${p.time}`);

    let optionsNames = [];
    if (p.selectedComplements && p.selectedComplements.length > 0) {
      for (const compId of p.selectedComplements) {
        const compRes = await client.query('SELECT name FROM complements WHERE id = $1', [compId]);
        if (compRes.rows[0]) optionsNames.push(compRes.rows[0].name);
      }
    }
    const bookingOptions = optionsNames.length > 0 ? optionsNames.join(', ') : null;
    const clientMessage = contact.notes || null;

    let isFirstSlot = true;
    for (const slot of slotsToBook) {
      const lastName = contact.lastName ? contact.lastName.toUpperCase() : '';
      const fullName = `${p.firstName} ${lastName}`.trim();
      const slotTitle = isFirstSlot ? fullName : `↪️ Suite ${fullName}`;
      const slotNotes = isFirstSlot ? null : 'Extension auto';

      await client.query(`
        UPDATE slots
        SET status = 'booked', title = $1, notes = $8, phone = $3, email = $4, weight_checked = true, flight_type_id = $5, booking_options = $6, client_message = $7, payment_data = $9,
            billing_name = $10, billing_email = $11, group_id = $12
        WHERE id = $2
      `, [slotTitle, slot.id, contact.phone, contact.email, p.flightId, bookingOptions, clientMessage, slotNotes, paymentData ? JSON.stringify(paymentData) : null, billingName, billingEmail, groupId]);

      try {
        const syncSetting = await client.query("SELECT value FROM site_settings WHERE key = 'google_calendar_sync'");
        if (syncSetting.rows.length > 0 && syncSetting.rows[0].value === 'true') {
          const monRes = await client.query('SELECT first_name FROM users WHERE id = $1', [chosenMonitor]);
          if (monRes.rows.length > 0 && isFirstSlot) {
            let desc = '';
            if (contact.phone) desc += `Tel: ${contact.phone}\n`;
            if (bookingOptions) desc += `Options: ${bookingOptions}\n`;
            if (clientMessage) desc += `Message client: ${clientMessage}\n`;
            notifyGoogleCalendar(monRes.rows[0].first_name, slotTitle, slot.start_time, slot.end_time, desc);
          }
        }
      } catch (e) { console.error('Erreur Synchro Google:', e); }

      const index = availableSlots.findIndex(s => s.id === slot.id);
      if (index > -1) availableSlots.splice(index, 1);
      isFirstSlot = false;
    }
  }
}

module.exports = { performBooking };
