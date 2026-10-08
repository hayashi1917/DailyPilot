import { runNotificationCycle } from "../../functions/notifications/scheduler.js";

// DailyPilot の通知用 Worker です。
// Cloudflare Pages には定期実行の仕組みがないため、Cron Trigger を持つ小さな Worker を別に用意し、
// Pages と同じ D1 を見て「いま送るべき通知」を判定・送信します。
export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runNotificationCycle(env, new Date(controller.scheduledTime)).then((summary) => {
        if (summary.notifications.length) console.log(JSON.stringify(summary));
      }),
    );
  },
};
