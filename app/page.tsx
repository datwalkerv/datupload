import { connection } from "next/server";
import { Suspense } from "react";
import { getHealth } from "@/lib/health";

const endpoints = [
  { method: "POST", path: "/api/files", note: "Upload a file (multipart, up to 4 MB)" },
  { method: "POST", path: "/api/files/uploads", note: "Start a large upload (Blob staging token)" },
  { method: "POST", path: "/api/files/complete", note: "Finish a large upload" },
  { method: "GET", path: "/api/files", note: "List files: page, limit, folder, search" },
  { method: "GET", path: "/api/files/:id", note: "Download (streams, supports Range)" },
  { method: "GET", path: "/api/files/:id/url", note: "Signed, expiring download URL" },
  { method: "PATCH", path: "/api/files/:id", note: "Make a file public or private" },
  { method: "DELETE", path: "/api/files/:id", note: "Delete file and Telegram messages" },
  { method: "GET", path: "/api/public/:id/:name", note: "Public file, no auth, CDN-cached" },
  { method: "GET", path: "/api/health", note: "Database and Telegram connectivity" },
  { method: "POST", path: "/api/admin/sync", note: "Best-effort channel import" },
];

const methodColor: Record<string, string> = {
  GET: "text-sky-300",
  POST: "text-emerald-300",
  DELETE: "text-rose-300",
};

const architecture = `client ──▶ Next.js API ──▶ Telegram Bot API ──▶ private channel
              │                                   (file bytes, ≤19 MB parts)
              └──▶ MongoDB  (catalog: id → message ids → file_ids)`;

const examples = `# Upload
curl -X POST https://storage.example.com/api/files \\
  -H "Authorization: Bearer $STORAGE_API_KEY" \\
  -F "file=@image.png" -F "folder=projects"

# List
curl -H "Authorization: Bearer $STORAGE_API_KEY" \\
  "https://storage.example.com/api/files?folder=projects&search=image"

# Download
curl -H "Authorization: Bearer $STORAGE_API_KEY" \\
  https://storage.example.com/api/files/<id> -o image.png

# Delete
curl -X DELETE -H "Authorization: Bearer $STORAGE_API_KEY" \\
  https://storage.example.com/api/files/<id>`;

const limits = [
  ["Part size", "Files are split into ≤19 MB Telegram documents, below the Bot API's 20 MB download limit."],
  ["Large uploads", "Requests over 4.5 MB can't reach a Vercel function, so they are staged in Vercel Blob first and deleted once stored."],
  ["Deletes", "Telegram only guarantees deleting messages younger than 48 hours. Older files leave the index, but their bytes may remain in the channel."],
  ["Sync", "Bots can't read channel history. Sync only finds files posted by people in the last 24 hours."],
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-20 sm:py-28">
      <header className="space-y-6">
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          <span className="font-mono">v1</span>
          <span className="h-3 w-px bg-neutral-800" />
          <Suspense fallback={<StatusDot label="Checking status" tone="idle" />}>
            <HealthBadge />
          </Suspense>
        </div>
        <h1 className="text-4xl font-semibold tracking-tight text-neutral-50 sm:text-5xl">
          Telegram Storage API
        </h1>
        <p className="max-w-xl text-lg leading-relaxed text-neutral-400">
          A small object-storage service. Files go into a private Telegram channel, MongoDB
          keeps the catalog, and you talk to a plain HTTP API with an API key.
        </p>
      </header>

      <Section title="Architecture">
        <Code>{architecture}</Code>
        <p className="mt-4 text-sm leading-relaxed text-neutral-500">
          Telegram has no &ldquo;list objects&rdquo; API, so MongoDB is the source of truth for
          what exists. Downloads are streamed through the API; the bot token never leaves the
          server.
        </p>
      </Section>

      <Section title="Endpoints">
        <div className="overflow-hidden rounded-lg border border-neutral-800">
          {endpoints.map((e, i) => (
            <div
              key={e.method + e.path}
              className={`flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 ${i > 0 ? "border-t border-neutral-800/80" : ""}`}
            >
              <span className={`w-16 shrink-0 font-mono text-xs ${methodColor[e.method]}`}>{e.method}</span>
              <span className="font-mono text-sm text-neutral-200 sm:w-56 sm:shrink-0">{e.path}</span>
              <span className="text-sm text-neutral-500">{e.note}</span>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-neutral-500">
          Every endpoint except <InlineCode>/api/health</InlineCode> and public files requires{" "}
          <InlineCode>Authorization: Bearer &lt;STORAGE_API_KEY&gt;</InlineCode>.
        </p>
      </Section>

      <Section title="Quick start">
        <Code>{examples}</Code>
      </Section>

      <Section title="Limits">
        <dl className="space-y-4">
          {limits.map(([term, text]) => (
            <div key={term} className="grid gap-1 sm:grid-cols-[9rem_1fr] sm:gap-4">
              <dt className="text-sm font-medium text-neutral-300">{term}</dt>
              <dd className="text-sm leading-relaxed text-neutral-500">{text}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <footer className="mt-24 border-t border-neutral-900 pt-6 text-xs text-neutral-600">
        See the README for setup, the large-upload flow and deployment notes.
      </footer>
    </main>
  );
}

async function HealthBadge() {
  await connection();
  const health = await getHealth();
  if (health.status === "ok") return <StatusDot label="All systems operational" tone="ok" />;
  const down = [health.database !== "connected" && "database", health.telegram !== "connected" && "Telegram"]
    .filter(Boolean)
    .join(" and ");
  return <StatusDot label={`Degraded: ${down} unavailable`} tone="bad" />;
}

function StatusDot({ label, tone }: { label: string; tone: "ok" | "bad" | "idle" }) {
  const color = { ok: "bg-emerald-400", bad: "bg-amber-400", idle: "bg-neutral-600" }[tone];
  return (
    <span className="flex items-center gap-2">
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      {label}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-20">
      <h2 className="mb-5 text-sm font-medium uppercase tracking-wider text-neutral-500">{title}</h2>
      {children}
    </section>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950 p-4 font-mono text-[13px] leading-relaxed text-neutral-300">
      <code>{children}</code>
    </pre>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 font-mono text-[12px] text-neutral-300">
      {children}
    </code>
  );
}
