import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const entrySchema = z.object({
  at: z.number(),
  peak: z.number(),
  sources: z.number(),
  facing: z.enum(["user", "environment"]),
});

export const appendTxtLog = createServerFn({ method: "POST" })
  .validator(entrySchema)
  .handler(async ({ data }) => {
    const { writeIrLogLine } = await import("./ir-txt-log.server");
    await writeIrLogLine(data);
    return { ok: true as const };
  });

export const readTxtLog = createServerFn({ method: "GET" }).handler(async () => {
  const { readIrLogText } = await import("./ir-txt-log.server");
  return { text: await readIrLogText() };
});
