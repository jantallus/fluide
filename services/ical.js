const formatDate = (date) => date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

const BLOCKED_TITLES = ['PAUSE', 'NON DISPO'];

async function generateICalFeed(pool, monitorId) {
  const userRes = await pool.query('SELECT first_name FROM users WHERE id = $1', [monitorId]);
  if (userRes.rows.length === 0) return null;
  const monitorName = userRes.rows[0].first_name;

  const slotsRes = await pool.query(`
    SELECT s.*, ft.name as flight_name
    FROM slots s
    LEFT JOIN flight_types ft ON s.flight_type_id = ft.id
    WHERE s.monitor_id = $1
      AND s.status = 'booked'
      AND s.title IS NOT NULL
      AND s.title NOT LIKE '↪️ Suite%'
      AND s.title != 'NOTE'
      AND s.start_time >= NOW() - INTERVAL '30 days'
    ORDER BY s.start_time ASC
  `, [monitorId]);

  let ical = 'BEGIN:VCALENDAR\r\n';
  ical += 'VERSION:2.0\r\n';
  ical += `PRODID:-//Fluide Parapente//${monitorName}//FR\r\n`;
  ical += 'CALSCALE:GREGORIAN\r\n';
  ical += `X-WR-CALNAME:Planning Fluide - ${monitorName}\r\n`;
  ical += 'X-WR-TIMEZONE:Europe/Paris\r\n';

  slotsRes.rows.forEach(slot => {
    const title = slot.title || '';
    const upper = title.toUpperCase();
    if (BLOCKED_TITLES.some(t => upper.includes(t)) || title.includes('☕') || title.includes('❌') || upper === 'NOTE') return;

    const summary = slot.flight_name ? `${title} (${slot.flight_name})` : title;
    let description = '';
    if (slot.phone) description += `Tel: ${slot.phone}\\n`;
    if (slot.booking_options) description += `Options: ${slot.booking_options}\\n`;
    if (slot.notes) description += `Notes: ${slot.notes}\\n`;
    if (slot.client_message) description += `Message client: ${slot.client_message}\\n`;

    ical += 'BEGIN:VEVENT\r\n';
    ical += `UID:slot-${slot.id}@fluide-parapente.fr\r\n`;
    ical += `DTSTAMP:${formatDate(new Date())}\r\n`;
    ical += `DTSTART:${formatDate(new Date(slot.start_time))}\r\n`;
    ical += `DTEND:${formatDate(new Date(slot.end_time))}\r\n`;
    ical += `SUMMARY:${summary}\r\n`;
    if (description) ical += `DESCRIPTION:${description}\r\n`;
    ical += 'END:VEVENT\r\n';
  });

  ical += 'END:VCALENDAR\r\n';
  return { ical, monitorName };
}

module.exports = { generateICalFeed };
