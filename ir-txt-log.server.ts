import { mkdir, access, writeFile, appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export const IR_LOG_PATH =
  process.env.IR_LOG_PATH ||
  (process.env.VERCEL ? "/tmp/ir-activity.txt" : "/workspace/logs/ir-activity.txt");

export type IrLogKind = "hit" | "session" | "record" | "error" | "boot" | "diag";

export type IrLogLine = {
  at: number;
  kind?: IrLogKind;
  event?: string;
  peak: number;
  sources: number;
  facing: "user" | "environment";
  threshold?: number;
  spots?: string;
  note?: string;
  extra?: string;
};

const HEADER =
  "# IR Sight activity log v3\n# iso\tkind\tevent\tpeak\tsources\tfacing\tthr\tspots\tnote\textra\n";

const KINDS: IrLogKind[] = ["hit", "session", "record", "error", "boot", "diag"];

export function isLogKind(v: string | undefined): v is IrLogKind {
  return !!v && (KINDS as string[]).includes(v);
}

function formatLine(data: IrLogLine) {
  const kind = data.kind ?? "hit";
  const event = data.event ?? "-";
  const note = (data.note ?? "").replace(/[\t\n]/g, " ");
  const extra = (data.extra ?? "").replace(/[\t\n]/g, " ");
  return `${new Date(data.at).toISOString()}\t${kind}\t${event}\tpeak=${data.peak}\tsources=${data.sources}\tfacing=${data.facing}\tthr=${data.threshold ?? ""}\tspots=${data.spots ?? ""}\t${note}\t${extra}\n`;
}

export async function writeIrLogLine(data: IrLogLine) {
  try {
    await mkdir(dirname(IR_LOG_PATH), { recursive: true });
    try {
      await access(IR_LOG_PATH);
    } catch {
      await writeFile(IR_LOG_PATH, HEADER, "utf8");
    }
    await appendFile(IR_LOG_PATH, formatLine(data), "utf8");
  } catch {
    /* ephemeral filesystem on serverless — client still has the notebook */
  }
}

export async function readIrLogText() {
  try {
    return await readFile(IR_LOG_PATH, "utf8");
  } catch {
    return "";
  }
}
