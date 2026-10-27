import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { registerApi } from "./api";
import { registerControl } from "./control";
import type { AppContext } from "./env";
import { ensureReady } from "./ready";
import { registerShop } from "./shop";
import { recordEvent } from "./telemetry";

const app = new Hono<AppContext>();

app.use("*", async (c, next) => {
  const started = Date.now();
  c.set("obs", null);
  c.set("sessionId", null);
  c.set("trialId", null);
  c.set("userId", null);
  await ensureReady(c.env);
  const path = new URL(c.req.url).pathname;
  if (!path.startsWith("/_control")) {
    const sid = getCookie(c, "sid");
    const session = sid
      ? await c.env.DB.prepare("SELECT id, user_id, trial_id FROM sessions WHERE id = ?")
          .bind(sid)
          .first<{ id: string; user_id: string | null; trial_id: string | null }>()
      : null;
    if (session) {
      c.set("sessionId", session.id);
      c.set("trialId", session.trial_id);
      c.set("userId", session.user_id);
    } else if (!path.startsWith("/assets/") && !path.startsWith("/t/")) {
      const id = crypto.randomUUID();
      await c.env.DB.prepare("INSERT INTO sessions (id, user_id, trial_id, created_at) VALUES (?, NULL, NULL, ?)")
        .bind(id, Date.now())
        .run();
      setCookie(c, "sid", id, { path: "/", httpOnly: true, sameSite: "Lax" });
      c.set("sessionId", id);
    }
  }
  try {
    await next();
  } finally {
    if (!path.startsWith("/_control")) {
      try {
        await recordEvent(c, started);
      } catch (error) {
        console.log(JSON.stringify({ kind: "event_skip", message: error instanceof Error ? error.message : "error" }));
      }
    }
  }
});

registerControl(app);
registerApi(app);
registerShop(app);

app.notFound((c) => {
  c.set("obs", { action: "error" });
  return c.text("Not found", 404);
});

app.onError((error, c) => {
  console.log(JSON.stringify({ kind: "shop_error", message: error instanceof Error ? error.message : "error" }));
  c.set("obs", { action: "error" });
  return c.text("The shop is unavailable.", 500);
});

export default app;
