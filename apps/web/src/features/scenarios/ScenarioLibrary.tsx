import { useEffect, useMemo, useState } from "react";
import { getScenarioCatalog } from "./scenarios.api";
import type { Scenario, ScenarioCatalog } from "../../shared/types/api";
import { Icon } from "../../shared/ui/Icon";

const riskLabels: Record<Scenario["risk"], string> = {
  controlled: "Control",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

function ScenarioCard({ scenario, index }: { scenario: Scenario; index: number }) {
  const expected = scenario.expected === "allow" ? "ALLOW" : "BLOCK";

  return (
    <article className={`scenario-card scenario-card--${scenario.risk}`}>
      <div className="scenario-card__topline">
        <span className="scenario-card__index">SCN-{String(index + 1).padStart(2, "0")}</span>
        <span className={`scenario-risk scenario-risk--${scenario.risk}`}>
          <i />
          {riskLabels[scenario.risk]} risk
        </span>
      </div>
      <div className="scenario-card__labels">
        <span className="scenario-card__category">{scenario.category}</span>
        <span className="scenario-card__attack">{scenario.attackClass}</span>
      </div>
      <h3>{scenario.title}</h3>
      <p>{scenario.description}</p>
      <div className="scenario-card__control">
        <span>Security objective</span>
        <strong>{scenario.objective}</strong>
        <small>{scenario.control}</small>
      </div>
      <div className="scenario-card__meta">
        <div>
          <span>Expected behavior</span>
          <strong className={`scenario-outcome scenario-outcome--${scenario.expected}`}>
            <i />
            {expected}
          </strong>
        </div>
        <div>
          <span>Test fixture</span>
          <strong>
            {scenario.orderId}
            {scenario.amount > 0 ? ` · $${scenario.amount}` : ""}
          </strong>
        </div>
      </div>
      <div className="scenario-card__footer">
        <span>
          <Icon name="shield" size={13} />
          Server-side policy check
        </span>
        <code>{scenario.id}</code>
      </div>
    </article>
  );
}

export function ScenarioLibrary({ onUpgrade }: { onUpgrade: () => void }) {
  const [catalog, setCatalog] = useState<ScenarioCatalog | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadCatalog() {
    setLoading(true);
    setError("");
    try {
      setCatalog(await getScenarioCatalog());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Scenario catalog could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCatalog();
  }, []);

  const categories = useMemo(
    () => Array.from(new Set(catalog?.scenarios.map((scenario) => scenario.category) ?? [])).sort(),
    [catalog],
  );

  const filteredScenarios = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (catalog?.scenarios ?? []).filter((scenario) => {
      const matchesCategory = category === "all" || scenario.category === category;
      const searchable = `${scenario.title} ${scenario.category} ${scenario.description} ${scenario.id}`.toLowerCase();
      return matchesCategory && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
  }, [catalog, category, query]);

  const blockedCount = catalog?.scenarios.filter((scenario) => scenario.expected === "block").length ?? 0;
  const allowCount = catalog?.scenarios.filter((scenario) => scenario.expected === "allow").length ?? 0;

  return (
    <section className="workspace-view scenario-library">
      <div className="workspace-view__heading scenario-library__heading">
        <div>
          <span className="eyebrow eyebrow--cyan">SCENARIO LIBRARY</span>
          <h2>Know exactly what your agent is tested against.</h2>
          <p>
            Every scan runs the same transparent adversarial and boundary checks against your active policy.
          </p>
        </div>
        {catalog ? (
          <div className="scenario-policy-badge">
            <Icon name="shield" size={17} />
            <div>
              <span>ACTIVE POLICY</span>
              <strong>{catalog.policy.name}</strong>
            </div>
            <small>
              ${catalog.policy.maxAmount} max · {catalog.policy.maxAgeDays}d window
            </small>
          </div>
        ) : null}
      </div>

      <div className="scenario-library__summary">
        <div>
          <span>Total scenarios</span>
          <strong>{catalog?.scenarios.length ?? "—"}</strong>
          <small>Executed on every scan</small>
        </div>
        <div>
          <span>Expected blocks</span>
          <strong className="scenario-summary__value--orange">{catalog ? blockedCount : "—"}</strong>
          <small>Abuse and bypass attempts</small>
        </div>
        <div>
          <span>Expected allows</span>
          <strong className="scenario-summary__value--cyan">{catalog ? allowCount : "—"}</strong>
          <small>Safe behavior controls</small>
        </div>
        <div>
          <span>Test categories</span>
          <strong>{catalog ? categories.length : "—"}</strong>
          <small>Coverage dimensions</small>
        </div>
      </div>

      {catalog && catalog.entitlements.lockedScenarioCount > 0 ? (
        <div className="scenario-library__upgrade">
          <div className="scenario-library__upgrade-icon"><Icon name="lock" size={16} /></div>
          <div>
            <strong>{catalog.entitlements.lockedScenarioCount} advanced scenarios are reserved for Builder+</strong>
            <span>Your Explorer scans cover the five essential boundaries. Unlock the full adversarial suite for injection, privilege, cross-tenant, exfiltration, and tool-chain attacks.</span>
          </div>
          <button type="button" className="button button--ghost" onClick={onUpgrade}>Unlock full suite <Icon name="arrow" size={14} /></button>
        </div>
      ) : null}

      <div className="scenario-library__toolbar">
        <label className="scenario-search">
          <Icon name="search" size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search scenarios, categories, or IDs"
            aria-label="Search scenarios"
          />
        </label>
        <label className="scenario-filter">
          <span>Filter category</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter by category">
            <option value="all">All categories</option>
            {categories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <span className="scenario-library__result-count">
          {filteredScenarios.length} of {catalog?.scenarios.length ?? 0} visible
        </span>
      </div>

      {loading ? (
        <div className="scenario-library__loading" aria-live="polite">
          <div />
          <div />
          <div />
          <span>Loading verified scenario definitions…</span>
        </div>
      ) : error ? (
        <div className="scenario-library__error" role="alert">
          <Icon name="activity" size={16} />
          <div>
            <strong>Scenario catalog unavailable</strong>
            <span>{error}</span>
          </div>
          <button className="button button--subtle" onClick={() => void loadCatalog()}>
            Retry
          </button>
        </div>
      ) : filteredScenarios.length ? (
        <div className="scenario-library__grid">
          {filteredScenarios.map((scenario) => (
            <ScenarioCard key={scenario.id} scenario={scenario} index={catalog?.scenarios.indexOf(scenario) ?? 0} />
          ))}
        </div>
      ) : (
        <div className="scenario-library__empty">
          <Icon name="search" size={17} />
          <strong>No matching scenarios</strong>
          <span>Try a different search term or reset the category filter.</span>
          <button
            className="button button--subtle"
            onClick={() => {
              setQuery("");
              setCategory("all");
            }}
          >
            Clear filters
          </button>
        </div>
      )}
    </section>
  );
}
