import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { ApiError, projectsApi } from "@/api/client.ts";
import type {
	DefaultsConfig,
	ProjectRow,
	Trigger,
	WarrenConfigFileError,
	WarrenConfigResponse,
} from "@/api/types.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { formatTimestamp } from "@/lib/utils.ts";

export function ProjectDetailPage() {
	const { id = "" } = useParams<{ id: string }>();

	// Reuse the projects-list cache rather than introducing a GET /projects/:id —
	// the list endpoint is the only project-row source today (warren-435b shipped
	// only the warren-config sub-resource), and the projects page primes this
	// cache on the way in.
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const warrenConfig = useQuery({
		queryKey: ["projects", id, "warren-config"],
		queryFn: ({ signal }) => projectsApi.warrenConfig(id, signal),
		enabled: id.length > 0,
	});

	const project: ProjectRow | undefined = projects.data?.projects.find((p) => p.id === id);

	return (
		<div className="space-y-6">
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
						<Link to="/projects">
							<ArrowLeft className="h-4 w-4" />
							Projects
						</Link>
					</Button>
					<h1 className="font-mono text-xl font-semibold">{id}</h1>
					{project ? (
						<p className="mt-1 font-mono text-xs text-(--color-muted-foreground)">
							{project.gitUrl}
						</p>
					) : null}
				</div>
			</header>

			{projects.isLoading ? (
				<p className="text-sm text-(--color-muted-foreground)">Loading…</p>
			) : projects.isError ? (
				<p className="text-sm text-(--color-destructive)">
					{projects.error instanceof Error ? projects.error.message : String(projects.error)}
				</p>
			) : project === undefined ? (
				<p className="text-sm text-(--color-destructive)">Project not found.</p>
			) : (
				<>
					<ProjectMetaCard project={project} />
					<WarrenConfigPanel
						query={warrenConfig.data}
						isLoading={warrenConfig.isLoading}
						error={warrenConfig.error}
					/>
				</>
			)}
		</div>
	);
}

function ProjectMetaCard({ project }: { project: ProjectRow }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Project</CardTitle>
			</CardHeader>
			<CardContent>
				<dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2">
					<MetaRow label="Local path" value={<code className="text-xs">{project.localPath}</code>} />
					<MetaRow label="Default branch" value={project.defaultBranch} />
					<MetaRow
						label="Last HEAD"
						value={
							<code
								className="text-xs"
								title={project.lastHeadSha ?? "never fetched"}
							>
								{project.lastHeadSha !== null ? project.lastHeadSha.slice(0, 12) : "—"}
							</code>
						}
					/>
					<MetaRow
						label="Last fetched"
						value={
							project.lastFetchedAt !== null
								? formatTimestamp(project.lastFetchedAt)
								: "never"
						}
					/>
					<MetaRow label="Added" value={formatTimestamp(project.addedAt)} />
				</dl>
			</CardContent>
		</Card>
	);
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="flex items-baseline gap-3">
			<dt className="w-32 shrink-0 text-(--color-muted-foreground)">{label}</dt>
			<dd className="min-w-0 break-all">{value}</dd>
		</div>
	);
}

function WarrenConfigPanel({
	query,
	isLoading,
	error,
}: {
	query: WarrenConfigResponse | undefined;
	isLoading: boolean;
	error: unknown;
}) {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-baseline justify-between gap-3">
					<CardTitle>
						<span className="mr-2">Warren config</span>
						<code className="text-xs font-normal text-(--color-muted-foreground)">.warren/</code>
					</CardTitle>
					{query !== undefined && query.errors.length > 0 ? (
						<Badge variant="failed" className="font-mono text-xs">
							{query.errors.length} error{query.errors.length === 1 ? "" : "s"}
						</Badge>
					) : null}
				</div>
			</CardHeader>
			<CardContent className="space-y-6">
				{isLoading ? (
					<p className="text-sm text-(--color-muted-foreground)">Loading…</p>
				) : error !== null && error !== undefined ? (
					<WarrenConfigError error={error} />
				) : query === undefined ? null : (
					<>
						<TriggersBlock triggers={query.triggers} />
						<DefaultsBlock defaults={query.defaults} />
						{query.errors.length > 0 ? <ErrorsBlock errors={query.errors} /> : null}
					</>
				)}
			</CardContent>
		</Card>
	);
}

function WarrenConfigError({ error }: { error: unknown }) {
	if (error instanceof ApiError && error.status === 503) {
		return (
			<div className="space-y-1 text-sm">
				<p className="text-(--color-destructive)">{error.message}</p>
				{error.hint !== undefined ? (
					<p className="text-xs text-(--color-muted-foreground)">{error.hint}</p>
				) : null}
			</div>
		);
	}
	const message = error instanceof Error ? error.message : String(error);
	return <p className="text-sm text-(--color-destructive)">{message}</p>;
}

function TriggersBlock({ triggers }: { triggers: Trigger[] | null }) {
	return (
		<section>
			<h3 className="mb-2 text-sm font-semibold">
				<code className="font-mono">.warren/triggers.yaml</code>
			</h3>
			{triggers === null ? (
				<EmptyHint text="Not present (or last load failed — see errors below)." />
			) : triggers.length === 0 ? (
				<EmptyHint text="File is present but defines no triggers." />
			) : (
				<ul className="space-y-2">
					{triggers.map((t) => (
						<li
							key={t.id}
							className="rounded-md border bg-(--color-muted)/30 px-3 py-2 text-sm"
						>
							<div className="flex flex-wrap items-baseline gap-2">
								<span className="font-mono font-semibold">{t.id}</span>
								<Badge variant="secondary" className="font-mono text-xs">
									{t.kind}
								</Badge>
								<code className="text-xs text-(--color-muted-foreground)">{t.cron}</code>
								{t.timezone !== undefined ? (
									<span className="text-xs text-(--color-muted-foreground)">
										tz: {t.timezone}
									</span>
								) : null}
							</div>
							<dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
								<dt className="text-(--color-muted-foreground)">seed</dt>
								<dd className="font-mono">{t.seed}</dd>
								<dt className="text-(--color-muted-foreground)">role</dt>
								<dd className="font-mono">{t.role}</dd>
								{t.prompt !== undefined ? (
									<>
										<dt className="text-(--color-muted-foreground)">prompt</dt>
										<dd className="break-words">{t.prompt}</dd>
									</>
								) : null}
							</dl>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function DefaultsBlock({ defaults }: { defaults: DefaultsConfig | null }) {
	const isEmpty =
		defaults !== null &&
		defaults.defaultRole === undefined &&
		defaults.defaultBranch === undefined &&
		defaults.defaultPrompt === undefined;
	return (
		<section>
			<h3 className="mb-2 text-sm font-semibold">
				<code className="font-mono">.warren/defaults.json</code>
			</h3>
			{defaults === null ? (
				<EmptyHint text="Not present (or last load failed — see errors below)." />
			) : isEmpty ? (
				<EmptyHint text="File is present but sets no overrides." />
			) : (
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
					{defaults.defaultRole !== undefined ? (
						<>
							<dt className="text-(--color-muted-foreground)">defaultRole</dt>
							<dd className="font-mono">{defaults.defaultRole}</dd>
						</>
					) : null}
					{defaults.defaultBranch !== undefined ? (
						<>
							<dt className="text-(--color-muted-foreground)">defaultBranch</dt>
							<dd className="font-mono">{defaults.defaultBranch}</dd>
						</>
					) : null}
					{defaults.defaultPrompt !== undefined ? (
						<>
							<dt className="text-(--color-muted-foreground)">defaultPrompt</dt>
							<dd className="break-words">{defaults.defaultPrompt}</dd>
						</>
					) : null}
				</dl>
			)}
		</section>
	);
}

function ErrorsBlock({ errors }: { errors: WarrenConfigFileError[] }) {
	return (
		<section>
			<h3 className="mb-2 text-sm font-semibold text-(--color-destructive)">
				Validation errors
			</h3>
			<ul className="space-y-2">
				{errors.map((e) => (
					<li
						key={`${e.file}:${e.code}`}
						className="rounded-md border border-(--color-destructive)/40 bg-(--color-destructive)/5 px-3 py-2 text-sm"
					>
						<div className="flex flex-wrap items-baseline gap-2">
							<code className="font-mono text-xs">{e.file}</code>
							<Badge variant="failed" className="font-mono text-xs">
								{e.code}
							</Badge>
						</div>
						<p className="mt-1 break-words text-xs">{e.message}</p>
					</li>
				))}
			</ul>
		</section>
	);
}

function EmptyHint({ text }: { text: string }) {
	return <p className="text-sm text-(--color-muted-foreground)">{text}</p>;
}
