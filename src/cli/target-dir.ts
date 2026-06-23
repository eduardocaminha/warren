import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { NotFoundError, ValidationError } from "../core/errors.ts";

export type TargetDirArgs =
	| { readonly mode: "cwd"; readonly cwd: string }
	| { readonly mode: "project"; readonly projectId: string };

export interface TargetDirDeps {
	readonly projects: {
		get(id: string): Promise<{ readonly localPath: string } | null>;
	};
}

export async function resolveTargetDir(deps: TargetDirDeps, args: TargetDirArgs): Promise<string> {
	if (args.mode === "cwd") {
		const cwd = args.cwd;
		if (cwd === "") {
			throw new ValidationError("--cwd path is empty");
		}
		const abs = isAbsolute(cwd) ? cwd : resolve(cwd);
		if (!existsSync(abs)) {
			throw new ValidationError(`target directory does not exist: ${abs}`);
		}
		return abs;
	}
	const row = await deps.projects.get(args.projectId);
	if (row === null) {
		throw new NotFoundError(`project not found: ${args.projectId}`);
	}
	if (!existsSync(row.localPath)) {
		throw new ValidationError(`project clone missing on disk: ${row.localPath}`, {
			recoveryHint: "POST /projects/:id/refresh or re-add the project",
		});
	}
	return row.localPath;
}
