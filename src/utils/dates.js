/**
 * Devuelve una nueva fecha sumando `months` meses, preservando el día cuando
 * es posible (maneja meses más cortos: 31-ene + 1 mes → 28/29-feb).
 */
export function addMonths(date, months) {
  const d = new Date(date);
  const targetDay = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(targetDay, lastDay));
  return d;
}
