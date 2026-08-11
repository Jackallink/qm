/**
 * Permission Gate: dangerous shell commands → ui.select confirmation.
 * Approval key uses stable danger patterns (not full command text) so QM's
 * approval grants survive across turns.
 */
export default function (pi) {
  const dangerous = [
    { key: "rm-rf", re: /\brm\s+(-rf?|--recursive)/i },
    { key: "sudo", re: /\bsudo\b/i },
    { key: "chmod-777", re: /\b(chmod|chown)\b.*777/i },
  ];
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "ipython" && event.toolName !== "bash") return;
    const raw = JSON.stringify(event.input ?? {});
    const cmd = event.input?.command ?? event.input?.code ?? raw;
    const m = dangerous.find((p) => p.re.test(String(cmd)));
    if (!m) return;
    if (!ctx.hasUI) return { block: true, reason: `Dangerous command blocked (no UI): ${m.key}` };
    const choice = await ctx.ui.select(`Dangerous command (${m.key})`, ["Yes", "No"]);
    if (choice !== "Yes") return { block: true, reason: `Blocked by user: ${m.key}` };
    return undefined;
  });
}
