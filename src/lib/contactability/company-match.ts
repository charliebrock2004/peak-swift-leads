/**
 * Which Companies House record, if any, is this business?
 *
 * The register is searched by name, and names repeat: "Highland Joinery Ltd"
 * exists in more than one town. So a record is only taken as this business
 * when its name matches AND something about where it is agrees — and only
 * when exactly one record qualifies. Anything less comes back as candidates
 * for a person to confirm, never as a guess. Attaching the wrong company would
 * give a sole trader a company's legal form, which is exactly the mistake the
 * contactability rules exist to prevent.
 *
 * Client-safe and pure.
 */
import { extractUkPostcode, type CompanyHit } from "../companies-house.ts";
import { nameRelation, normalizePostcode } from "../entity/resolve.ts";

export type CompanyCandidate = {
  hit: CompanyHit;
  name: "equal" | "contains" | "similar";
  place: "postcode" | "district" | "town" | "none";
  reasons: string[];
};

/** A candidate as the screen shows it, for a person to pick. */
export type CandidateSummary = {
  companyNumber: string;
  legalName: string;
  companyType: string;
  companyStatus: string;
  address: string;
  reasons: string[];
};

export type CompanyMatch =
  | { kind: "match"; hit: CompanyHit; reasons: string[] }
  | { kind: "ambiguous"; candidates: CompanyCandidate[] }
  | { kind: "none" };

function outward(postcode: string): string {
  const compact = normalizePostcode(postcode);
  return compact ? compact.slice(0, -3) : "";
}

export function matchCompany(
  business: { businessName: string; town: string; address?: string; postcode?: string },
  hits: readonly CompanyHit[],
): CompanyMatch {
  const postcode = normalizePostcode(business.postcode || extractUkPostcode(business.address ?? ""));
  const town = business.town.trim().toLowerCase();
  const candidates: CompanyCandidate[] = [];

  for (const hit of hits) {
    const name = nameRelation(business.businessName, hit.legalName || hit.businessName);
    if (name === "different") continue;
    const hitPostcode = normalizePostcode(hit.postcode);
    const place: CompanyCandidate["place"] =
      postcode && hitPostcode && postcode === hitPostcode
        ? "postcode"
        : postcode && hitPostcode && outward(postcode) === outward(hitPostcode)
          ? "district"
          : town && hit.town.trim().toLowerCase() === town
            ? "town"
            : "none";
    const reasons = [
      name === "equal" ? "Same name" : name === "contains" ? "One name contains the other" : "Near-identical name",
      place === "postcode"
        ? `same postcode (${hit.postcode})`
        : place === "district"
          ? `same postcode district (${outward(hitPostcode)})`
          : place === "town"
            ? `registered in ${hit.town}`
            : `registered office elsewhere (${hit.town || hit.postcode || "unknown"})`,
    ];
    candidates.push({ hit, name, place, reasons });
  }

  // Strong: the same name anywhere local, or a looser name at the same postcode.
  const strong = candidates.filter(
    (candidate) =>
      (candidate.name === "equal" && candidate.place !== "none") ||
      (candidate.name !== "equal" && candidate.place === "postcode"),
  );
  // …and only when no OTHER plausibly named company is local too: two local
  // candidates is a question for a person, however strong one of them looks.
  const local = candidates.filter((candidate) => candidate.place !== "none");
  if (strong.length === 1 && local.length === 1) return { kind: "match", hit: strong[0]!.hit, reasons: strong[0]!.reasons };
  if (candidates.length === 0) return { kind: "none" };
  return { kind: "ambiguous", candidates: candidates.slice(0, 5) };
}
