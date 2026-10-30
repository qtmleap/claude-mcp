import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { RunnerError } from "./errors.mjs";

export async function resolveWorkspace(cwd, root, mountedRoots = [root]) {
	const path = cwd ? (isAbsolute(cwd) ? cwd : resolve(root, cwd)) : root;
	const invalid = (reason) =>
		new RunnerError(
			"invalid_cwd",
			`The requested cwd is not available on the MCP host (${reason}). Omit cwd for questions that do not access files; file tasks must select an existing mounted directory.`,
			{
				reason,
				requested_cwd: cwd ?? null,
				resolved_path: path,
				default_cwd: root,
				mounted_roots: mountedRoots,
				execution_started: false,
			},
		);
	let info, canonical, roots;
	try {
		info = await stat(path);
	} catch (error) {
		throw invalid(
			error.code === "ENOENT" ? "path_not_found" : "path_not_accessible",
		);
	}
	if (!info.isDirectory()) throw invalid("not_a_directory");
	try {
		canonical = await realpath(path);
	} catch {
		throw invalid("path_not_accessible");
	}
	try {
		roots = await Promise.all(
			mountedRoots.map(async (p) => {
				const canonicalRoot = await realpath(p);
				if (!(await stat(canonicalRoot)).isDirectory())
					throw new Error("mounted root is not a directory");
				return canonicalRoot;
			}),
		);
	} catch {
		throw invalid("mounted_root_unavailable");
	}
	if (
		!roots.some((r) => {
			const rel = relative(r, canonical);
			return (
				rel === "" ||
				(rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))
			);
		})
	)
		throw invalid("outside_mounted_roots");
	return { cwd: canonical, roots: [...new Set(roots)] };
}
export async function resolveCwd(cwd, root, mountedRoots = [root]) {
	return (await resolveWorkspace(cwd, root, mountedRoots)).cwd;
}
