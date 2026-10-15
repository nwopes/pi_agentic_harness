import fs from "node:fs";

/**
 * Stream a JSONL file. Splits on LF only (Pi docs: Unicode line separators are valid inside JSON strings,
 * so node:readline is unsuitable), strips an optional CR. Pi 0.73.1 repeats the cumulative message in every
 * message_update event, so files can be large: never load them whole.
 */
export async function forEachJsonLine(
  file: string,
  onRecord: (rec: any, lineNo: number) => void,
): Promise<{ lines: number; parseErrors: number }> {
  let lines = 0;
  let parseErrors = 0;
  let buf = "";
  const handle = (line: string) => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) return;
    lines++;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      parseErrors++;
      return;
    }
    onRecord(rec, lines);
  };
  const stream = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  for await (const chunk of stream) {
    buf += chunk;
    let start = 0;
    let idx: number;
    while ((idx = buf.indexOf("\n", start)) !== -1) {
      handle(buf.slice(start, idx));
      start = idx + 1;
    }
    buf = buf.slice(start);
  }
  if (buf.length) handle(buf);
  return { lines, parseErrors };
}
