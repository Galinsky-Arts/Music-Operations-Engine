/** RFC 4180 CSV with spreadsheet formula-injection neutralization. */
export function csvCell(value) {
  if (value===null || value===undefined) return '';
  let text=typeof value==='object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text="'"+text;
  return /[",\r\n]/.test(text) ? '"'+text.replace(/"/g,'""')+'"' : text;
}
export function csvRow(values) { return values.map(csvCell).join(',')+'\r\n'; }
export const factColumns=['occurredAt','labelId','source','externalId','type','quantity','amountMinor','currency','artist','release','track','isrc','artistId','releaseId','trackId','channel','territory'];
export const rollupColumns=['date','labelId','source','type','currency','facts','quantity','amountMinor'];
