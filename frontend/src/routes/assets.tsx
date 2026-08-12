import { createFileRoute } from "@tanstack/react-router";
import { assets } from "@/data/mock";

export const Route = createFileRoute("/assets")({
  head: () => ({
    meta: [
      { title: "Asset navigation — INFER" },
      {
        name: "description",
        content: "Locate plant, equipment and maintenance assets and route facilities teams to them indoors.",
      },
      { property: "og:title", content: "Asset navigation — INFER" },
      { property: "og:description", content: "Facilities asset locations linked to the indoor navigation graph." },
    ],
  }),
  component: AssetsScreen,
});

function AssetsScreen() {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-3xl px-8 py-12">
        <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-foreground">Assets</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">Maintainable equipment linked to the navigation graph.</p>

        <ul className="mt-8">
          {assets.map((a) => (
            <li key={a.id} className="flex items-baseline gap-4 border-b border-border py-3 last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{a.name}</span>
              <span className="hidden text-[12px] text-muted-foreground sm:block">{a.location}</span>
              <span className="w-24 text-right text-[12px] text-muted-foreground tabular-nums">{a.nextService}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
