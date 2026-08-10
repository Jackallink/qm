/**
 * Test extension: dangerous shell in ipython/bash → ui.select
 * Title uses a STABLE key (matched pattern) so approval grants survive
 * across turns even when the model regenerates the exact command text.
 */
export default function (pi) {
	const dangerousPatterns = [
		{ key: "rm-rf", re: /\brm\s+(-rf?|--recursive)/i },
		{ key: "sudo", re: /\bsudo\b/i },
		{ key: "chmod-777", re: /\b(chmod|chown)\b.*777/i },
	];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "ipython" && event.toolName !== "bash") return undefined;
		const raw = JSON.stringify(event.input ?? {});
		const command = event.input?.command ?? event.input?.code ?? raw;
		const matched = dangerousPatterns.find((p) => p.re.test(String(command)));
		if (matched) {
			if (!ctx.hasUI) return { block: true, reason: `Dangerous command blocked (no UI): ${matched.key}` };
			const choice = await ctx.ui.select(`Dangerous command (${matched.key})`, ["Yes", "No"]);
			if (choice !== "Yes") return { block: true, reason: `Blocked by user: ${matched.key}` };
		}
		return undefined;
	});
}
