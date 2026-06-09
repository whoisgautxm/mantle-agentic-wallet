export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    ok: true,
    service: "mantle-agent-web",
    checkedAt: new Date().toISOString(),
  });
}
