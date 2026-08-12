import { useMemo, useState } from "react";
import { Filter, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { SeverityBadge, ProvenanceBadge } from "@/components/common/StatusBadges";
import { EmptyState } from "@/components/common/States";
import { storeys, validationIssues } from "@/data/mock";
import type { Severity, ValidationIssue } from "@/types/infer";

const severities: Severity[] = ["critical", "major", "minor", "info"];
const categories = ["connectivity", "classification", "accessibility", "geometry", "metadata"] as const;
const entityTypes = ["IfcDoor", "IfcSpace", "IfcStair", "IfcTransportElement", "IfcBuildingStorey", "IfcRamp", "IfcSite"];

export function ValidationIssueList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (issue: ValidationIssue) => void;
}) {
  const [query, setQuery] = useState("");
  const [sev, setSev] = useState<Severity[]>([]);
  const [storeyFilter, setStoreyFilter] = useState<string[]>([]);
  const [entityFilter, setEntityFilter] = useState<string[]>([]);
  const [catFilter, setCatFilter] = useState<string[]>([]);
  const [inferredOnly, setInferredOnly] = useState(false);

  const issues = useMemo(
    () =>
      validationIssues.filter((i) => {
        if (query && !`${i.title} ${i.entityLabel} ${i.guid}`.toLowerCase().includes(query.toLowerCase())) return false;
        if (sev.length && !sev.includes(i.severity)) return false;
        if (storeyFilter.length && !storeyFilter.includes(i.storeyId)) return false;
        if (entityFilter.length && !entityFilter.includes(i.entityClass)) return false;
        if (catFilter.length && !catFilter.includes(i.category)) return false;
        if (inferredOnly && i.provenance !== "inferred") return false;
        return true;
      }),
    [query, sev, storeyFilter, entityFilter, catFilter, inferredOnly],
  );

  const toggle = <T,>(list: T[], set: (v: T[]) => void, v: T) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <div className="flex h-full min-h-0">
      <aside aria-label="Issue filters" className="hidden w-52 shrink-0 overflow-auto border-r border-border bg-surface p-3 lg:block">
        <p className="label-caps mb-2 flex items-center gap-1.5 text-muted-foreground">
          <Filter aria-hidden className="size-3" /> Filters
        </p>
        <FilterGroup title="Severity">
          {severities.map((s) => (
            <FilterCheck key={s} label={s} checked={sev.includes(s)} onChange={() => toggle(sev, setSev, s)} />
          ))}
        </FilterGroup>
        <FilterGroup title="Storey">
          {storeys.map((s) => (
            <FilterCheck
              key={s.id}
              label={s.name}
              checked={storeyFilter.includes(s.id)}
              onChange={() => toggle(storeyFilter, setStoreyFilter, s.id)}
            />
          ))}
        </FilterGroup>
        <FilterGroup title="IFC entity type">
          {entityTypes.map((e) => (
            <FilterCheck
              key={e}
              label={e}
              checked={entityFilter.includes(e)}
              onChange={() => toggle(entityFilter, setEntityFilter, e)}
            />
          ))}
        </FilterGroup>
        <FilterGroup title="Category">
          {categories.map((c) => (
            <FilterCheck key={c} label={c} checked={catFilter.includes(c)} onChange={() => toggle(catFilter, setCatFilter, c)} />
          ))}
        </FilterGroup>
        <FilterGroup title="Provenance">
          <FilterCheck label="Inferred only" checked={inferredOnly} onChange={() => setInferredOnly(!inferredOnly)} />
        </FilterGroup>
        <Button
          size="sm"
          variant="outline"
          className="mt-2 w-full text-xs"
          onClick={() => {
            setSev([]);
            setStoreyFilter([]);
            setEntityFilter([]);
            setCatFilter([]);
            setInferredOnly(false);
          }}
        >
          Reset filters
        </Button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <div className="relative max-w-sm flex-1">
            <Search aria-hidden className="absolute top-2 left-2 size-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search issues, entities or GUIDs"
              className="h-7 pl-7 text-xs"
              aria-label="Search validation issues"
            />
          </div>
          <p className="ml-auto font-mono text-[11px] text-muted-foreground">
            {issues.length} of {validationIssues.length} issues
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {issues.length === 0 ? (
            <EmptyState title="No issues match these filters" description="Adjust or reset the filters to see other findings." />
          ) : (
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-border">
                  <Th>Issue</Th>
                  <Th className="hidden md:table-cell">Location</Th>
                  <Th className="hidden lg:table-cell">Entity</Th>
                  <Th>Severity</Th>
                  <Th className="hidden xl:table-cell">Confidence</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {issues.map((i) => {
                  const storey = storeys.find((s) => s.id === i.storeyId)?.name ?? "—";
                  return (
                    <tr
                      key={i.id}
                      tabIndex={0}
                      role="button"
                      aria-pressed={selectedId === i.id}
                      onClick={() => onSelect(i)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelect(i);
                        }
                      }}
                      className={cn(
                        "cursor-pointer border-b border-border align-top hover:bg-accent/60",
                        selectedId === i.id && "bg-primary/8",
                      )}
                    >
                      <Td className="max-w-[24rem]">
                        <p className="font-medium text-foreground">{i.title}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">{i.guid}</p>
                      </Td>
                      <Td className="hidden md:table-cell">{storey}</Td>
                      <Td className="hidden font-mono lg:table-cell">{i.entityClass}</Td>
                      <Td>
                        <SeverityBadge severity={i.severity} />
                      </Td>
                      <Td className="hidden font-mono xl:table-cell">{(i.confidence * 100).toFixed(0)}%</Td>
                      <Td>
                        <span className="flex flex-col items-start gap-1">
                          <span className="capitalize">{i.status}</span>
                          <ProvenanceBadge provenance={i.provenance} compact />
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={cn("label-caps px-3 py-2 font-semibold text-muted-foreground", className)}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn("px-3 py-2 text-muted-foreground", className)}>{children}</td>;
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="mb-3">
      <legend className="label-caps mb-1 text-muted-foreground">{title}</legend>
      <div className="space-y-0.5">{children}</div>
    </fieldset>
  );
}

function FilterCheck({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-xs capitalize hover:bg-accent hover:text-accent-foreground">
      <Checkbox checked={checked} onCheckedChange={onChange} />
      <span className="truncate">{label}</span>
    </label>
  );
}
