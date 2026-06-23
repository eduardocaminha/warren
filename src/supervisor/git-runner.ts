import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitRun = (
	cmd: string,
	args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const defaultGitRun: GitRun = async (cmd, args) => {
	try {
		const { stdout, stderr } = await execFileAsync(cmd, [...args]);
		return { exitCode: 0, stdout, stderr };
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
		const exitCode = typeof e.code === "number" ? e.code : 1;
		return {
			exitCode,
			stdout: typeof e.stdout === "string" ? e.stdout : "",
			stderr: typeof e.stderr === "string" ? e.stderr : (e.message ?? ""),
		};
	}
};
