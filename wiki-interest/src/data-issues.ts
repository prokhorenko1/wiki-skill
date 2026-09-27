import type { Period } from './schemas.js';

export const issueSource = 'https://wikitech.wikimedia.org/wiki/Data_Platform/Data_Lake/Data_Issues/2026-06-10_Nov_2025_spike_in_bot_traffic';
const base = 'https://wikitech.wikimedia.org/wiki/Data_Platform/Data_Lake/Data_Issues/';
const issues = [
  { id: 'wmf-2024-webrequest-loss', source: `${base}2024-10-10_Webrequest_Data_Loss_-_Clobbered_Hadoop_Temporary_Dir`, period: { start: '2023-05-11', end: '2024-09-09' }, status: 'closed_with_historical_loss', backfillCompleted: null,
    note: 'Офіційно описана часткова втрата webrequest, що живить pageviews. Історія до 09.09.2024 залишається неповною; глобальна оцінка не визначає вплив на окрему статтю.' },
  { id: 'wmf-2024-classification', source: `${base}2024-09-20_Unique_Devices_by_Family_Inflated_Due_to_Miscategorized_Traffic`, period: { start: '2024-08-01', end: '2024-11-30' }, status: 'classification_fixed_page_backfill_not_confirmed', backfillCompleted: null,
    note: 'У змішаному звіті окремо зазначено вплив класифікації ботів на pageviews переважно у вересні–жовтні, частково серпні–листопаді. Виправлено 04.12.2024. Backfill unique devices не доводить backfill pageviews; вплив на конкретні статті невідомий.' },
  { id: 'wmf-2025-may-bot-traffic', source: `${base}2025-06-03_May_2025_spike_in_bot_traffic`, period: { start: '2025-03-20', end: '2025-08-28' }, status: 'resolved_and_backfilled', backfillCompleted: '2025-10-08',
    note: 'Оновлено класифікацію 28.08.2025; backfill pageviews від 20.03.2025 завершено 08.10.2025. Пізніші знімки можуть уже містити виправлення; це не доказ спотворення конкретної статті.' },
  { id: 'wmf-2025-haproxy-loss', source: `${base}2025-06-30_Haproxykafka_silently_stopped_sending_request_data_to_Kafka`, period: { start: '2025-05-11', end: '2025-07-23' }, status: 'closed_with_data_loss', backfillCompleted: null,
    note: 'Втрата частини запитів із двох серверів у підінтервалах зазначеного діапазону; інцидент закрито 22.08.2025. Глобальні оцінки не використано як коефіцієнт корекції сторінок.' },
  { id: 'wmf-2025-11-bot-traffic', source: issueSource, period: { start: '2025-11-01', end: '2026-04-04' }, status: 'resolved_with_unrepaired_november_2025', backfillCompleted: '2026-05-15',
    note: 'Офіційний інцидент класифікації трафіку: листопад 2025 не виправлено; backfill із грудня завершено 15.05.2026. Перетин дат не доводить впливу на цю статтю чи набір. Глобальний коефіцієнт корекції не застосовано.' },
];
export function knownDataIssues(period: Period) {
  return issues.filter(i => period.end >= i.period.start && period.start <= i.period.end).map(i => ({ ...i, reviewedAt: '2026-09-27' }));
}
