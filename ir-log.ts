import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/ir-log")({
  server: {
    handlers: {
      GET: async () => {
        const { readIrLogText } = await import("@/lib/ir-txt-log.server");
        const text = await readIrLogText();
        return new Response(text || "# IR Sight activity log v3\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
      POST: async ({ request }) => {
        const body = (await request.json()) as {
          at?: number;
          kind?: string;
          event?: string;
          peak?: number;
          sources?: number;
          facing?: string;
          threshold?: number;
          spots?: string;
          note?: string;
          extra?: string;
        };
        const { isLogKind, writeIrLogLine } = await import("@/lib/ir-txt-log.server");
        const kind = isLogKind(body.kind) ? body.kind : "hit";
        const at = typeof body.at === "number" ? body.at : Date.now();
        const facing = body.facing === "environment" ? "environment" : "user";
        const peak = typeof body.peak === "number" ? body.peak : 0;
        const sources = typeof body.sources === "number" ? body.sources : 0;
        if (kind === "hit" && (typeof body.peak !== "number" || typeof body.sources !== "number")) {
          return Response.json({ ok: false }, { status: 400 });
        }
        await writeIrLogLine({
          at,
          kind,
          event: typeof body.event === "string" ? body.event : undefined,
          peak,
          sources,
          facing,
          threshold: typeof body.threshold === "number" ? body.threshold : undefined,
          spots: typeof body.spots === "string" ? body.spots : undefined,
          note: typeof body.note === "string" ? body.note : undefined,
          extra: typeof body.extra === "string" ? body.extra : undefined,
        });
        return Response.json({ ok: true });
      },
    },
  },
});
