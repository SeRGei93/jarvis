import { fetchPageAsMarkdown, type PageParser } from "../fetch.js";
import { FETCH_LIMITS } from "../config.js";
import { webChild } from "../logger.js";
import {
  isMed103AptekaUrl,
  extractMed103AptekaContent,
  isMed103DoctorProfileUrl,
  extractMed103DoctorProfileContent,
  isMed103DoctorListUrl,
  extractMed103DoctorListContent,
  isMed103CatalogUrl,
  extractMed103CatalogContent,
  isMed103ClinicSubdomainUrl,
  extractMed103ClinicSubdomainContent,
} from "./103by-page.js";

const log = webChild("med103");

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

/** Injectable network surface for the med103 service (keeps tests offline). */
export interface WebDeps {
  /** Fetch implementation (defaults to global `fetch` inside the fetch layer). */
  fetchFn?: typeof globalThis.fetch;
  /** Per-request timeout in ms; falls back to {@link FETCH_LIMITS}. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Med103DoctorType {
  /** Tool suffix / consolidated enum value (e.g. `oftalmolog`). */
  value: string;
  /** Stable slug = URL path segment used by {@link buildDoctorUrl}. */
  slug: string;
  /** Original thin-tool name (kept for traceability). */
  tool: string;
  /** URL path segment for the specialty (alias of {@link slug}). */
  specialty: string;
  /** Human-readable label for the enum option. */
  label: string;
  description: string;
}

export interface Med103ClinicType {
  /** Consolidated enum value / tool suffix (e.g. `med_centers`). */
  value: string;
  /** Stable slug (alias of {@link value}). */
  slug: string;
  /** Original thin-tool name (kept for traceability). */
  tool: string;
  /** Catalog URL path segment used by {@link buildClinicUrl}. */
  path: string;
  /** Human-readable label for the enum option. */
  label: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Page-parser registry (shared by the fetch layer and the later tool task)
// ---------------------------------------------------------------------------

/**
 * Specialised 103.by page parsers, tried in order by {@link fetchPageAsMarkdown}.
 * Exported so the consolidated tool layer can reuse the exact same registry.
 */
export const med103PageParsers: PageParser[] = [
  { match: isMed103AptekaUrl, extract: extractMed103AptekaContent },
  { match: isMed103DoctorProfileUrl, extract: extractMed103DoctorProfileContent },
  { match: isMed103DoctorListUrl, extract: extractMed103DoctorListContent },
  { match: isMed103CatalogUrl, extract: extractMed103CatalogContent },
  { match: isMed103ClinicSubdomainUrl, extract: extractMed103ClinicSubdomainContent },
];

// ---------------------------------------------------------------------------
// Cities
// ---------------------------------------------------------------------------

export const MED103_CITIES: Record<string, string> = {
  minsk: "minsk",
  brest: "brest",
  gomel: "gomel",
  grodno: "grodno",
  vitebsk: "vitebsk",
  mogilev: "mogilev",
  baranovichi: "baranovichi",
};

// ---------------------------------------------------------------------------
// Doctor types (22 tools — one per specialty)
// ---------------------------------------------------------------------------

export const MED103_DOCTOR_TYPES: Med103DoctorType[] = [
  { value: "oftalmolog", slug: "oftalmolog", tool: "103by_oftalmolog", specialty: "oftalmolog", label: "Ophthalmologist", description: "Search ophthalmologists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "lor", slug: "lor", tool: "103by_lor", specialty: "lor", label: "ENT doctor (otolaryngologist)", description: "Search ENT doctors (otolaryngologists) on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "nevrolog", slug: "nevrolog", tool: "103by_nevrolog", specialty: "nevrolog", label: "Neurologist", description: "Search neurologists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "triholog", slug: "triholog", tool: "103by_triholog", specialty: "triholog", label: "Trichologist", description: "Search trichologists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "psihoterapevt", slug: "psihoterapevt", tool: "103by_psihoterapevt", specialty: "psihoterapevt", label: "Psychotherapist", description: "Search psychotherapists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "dermatolog", slug: "dermatolog", tool: "103by_dermatolog", specialty: "dermatolog", label: "Dermatologist", description: "Search dermatologists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "ginekolog", slug: "ginekolog", tool: "103by_ginekolog", specialty: "ginekolog", label: "Gynecologist", description: "Search gynecologists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "kardiolog", slug: "kardiolog", tool: "103by_kardiolog", specialty: "kardiolog", label: "Cardiologist", description: "Search cardiologists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "ortoped", slug: "ortoped", tool: "103by_ortoped", specialty: "ortoped", label: "Orthopedist", description: "Search orthopedists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "mammolog", slug: "mammolog", tool: "103by_mammolog", specialty: "mammolog", label: "Mammologist", description: "Search mammologists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "revmatolog", slug: "revmatolog", tool: "103by_revmatolog", specialty: "revmatolog", label: "Rheumatologist", description: "Search rheumatologists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "endokrinolog", slug: "endokrinolog", tool: "103by_endokrinolog", specialty: "endokrinolog", label: "Endocrinologist", description: "Search endocrinologists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "pediatr", slug: "pediatr", tool: "103by_pediatr", specialty: "pediatr", label: "Pediatrician", description: "Search pediatricians on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "gastroenterolog", slug: "gastroenterolog", tool: "103by_gastroenterolog", specialty: "gastroenterolog", label: "Gastroenterologist", description: "Search gastroenterologists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "allergolog", slug: "allergolog", tool: "103by_allergolog", specialty: "allergolog", label: "Allergist", description: "Search allergists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "proktolog", slug: "proktolog", tool: "103by_proktolog", specialty: "proktolog", label: "Proctologist", description: "Search proctologists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "pulmonolog", slug: "pulmonolog", tool: "103by_pulmonolog", specialty: "pulmonolog", label: "Pulmonologist", description: "Search pulmonologists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "terapevt", slug: "terapevt", tool: "103by_terapevt", specialty: "terapevt", label: "General practitioner (therapist)", description: "Search general practitioners (therapists) on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "urolog", slug: "urolog", tool: "103by_urolog", specialty: "urolog", label: "Urologist", description: "Search urologists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "hirurg", slug: "hirurg", tool: "103by_hirurg", specialty: "hirurg", label: "Surgeon", description: "Search surgeons on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "kosmetolog", slug: "kosmetolog", tool: "103by_kosmetolog", specialty: "kosmetolog", label: "Cosmetologist", description: "Search cosmetologists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
  { value: "stomatolog", slug: "stomatolog-terapevt", tool: "103by_stomatolog", specialty: "stomatolog-terapevt", label: "Dentist", description: "Search dentists on 103.by (Belarus). Returns list of doctors with names, clinics, ratings, prices. Optional city and page." },
];

// ---------------------------------------------------------------------------
// Clinic types (5 tools)
// ---------------------------------------------------------------------------

export const MED103_CLINIC_TYPES: Med103ClinicType[] = [
  { value: "med_centers", slug: "med_centers", tool: "103by_med_centers", path: "/cat/med/medicinskie-centry/", label: "Medical centers", description: "Search medical centers on 103.by (Belarus). Returns list of clinics with names, addresses, ratings. Optional city and page." },
  { value: "stomatologii", slug: "stomatologii", tool: "103by_stomatologii", path: "/cat/med/stomatologii/", label: "Dental clinics", description: "Search dental clinics on 103.by (Belarus). Returns list of dental clinics with names, addresses, ratings. Optional city and page." },
  { value: "bolnitsy", slug: "bolnitsy", tool: "103by_bolnitsy", path: "/cat/med/bolnitsy/", label: "Hospitals", description: "Search hospitals on 103.by (Belarus). Returns list of hospitals with names, addresses, ratings. Optional city and page." },
  { value: "polikliniki", slug: "polikliniki", tool: "103by_polikliniki", path: "/cat/med/polikliniki/", label: "Polyclinics", description: "Search polyclinics on 103.by (Belarus). Returns list of polyclinics with names, addresses, ratings. Optional city and page." },
  { value: "vetkliniki", slug: "vetkliniki", tool: "103by_vetkliniki", path: "/cat/vet/vetkliniki/", label: "Veterinary clinics", description: "Search veterinary clinics on 103.by (Belarus). Returns list of vet clinics with names, addresses, ratings, prices. Optional city and page." },
];

// ---------------------------------------------------------------------------
// Sort orders for doctor listings
// ---------------------------------------------------------------------------

export const MED103_SORT_ORDERS = ["reviews", "rating", "prices", "work_experience"] as const;
export type Med103SortOrder = typeof MED103_SORT_ORDERS[number];

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

function appendQueryParams(url: string, params: Record<string, string>): string {
  const entries = Object.entries(params).filter(([, v]) => v);
  if (entries.length === 0) return url;
  const sep = url.includes("?") ? "&" : "?";
  return url + sep + entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

function buildDoctorUrl(specialty: string, params: { city?: string; page?: number; sort_order?: string }): string {
  const city = params.city?.toLowerCase().trim();
  if (city && !MED103_CITIES[city]) {
    throw new Error(`Unknown city "${params.city}". Available: ${Object.keys(MED103_CITIES).join(", ")}`);
  }

  // https://www.103.by/doctor/oftalmolog/minsk/?sort_order=rating&page=2
  let url = `https://www.103.by/doctor/${specialty}/`;
  if (city) {
    url += `${city}/`;
  }
  const qp: Record<string, string> = {};
  if (params.sort_order) qp.sort_order = params.sort_order;
  if (params.page != null && params.page > 1) qp.page = String(params.page);
  return appendQueryParams(url, qp);
}

function buildClinicUrl(path: string, params: { city?: string; page?: number }): string {
  const city = params.city?.toLowerCase().trim();
  if (city && !MED103_CITIES[city]) {
    throw new Error(`Unknown city "${params.city}". Available: ${Object.keys(MED103_CITIES).join(", ")}`);
  }

  // https://www.103.by/cat/med/medicinskie-centry/minsk/?page=2
  let url = `https://www.103.by${path}`;
  if (city) {
    url += `${city}/`;
  }
  if (params.page != null && params.page > 1) {
    url += `?page=${params.page}`;
  }
  return url;
}

function buildServiceUrl(service: string, params: { city?: string }): string {
  const city = params.city?.toLowerCase().trim();
  if (city && !MED103_CITIES[city]) {
    throw new Error(`Unknown city "${params.city}". Available: ${Object.keys(MED103_CITIES).join(", ")}`);
  }

  // https://www.103.by/list/mrt/minsk/
  let url = `https://www.103.by/list/${service}/`;
  if (city) {
    url += `${city}/`;
  }
  return url;
}

function buildPharmacyUrl(medicine: string): string {
  // https://apteka.103.by/search/?q=парацетамол
  return `https://apteka.103.by/search/?q=${encodeURIComponent(medicine)}`;
}

// ---------------------------------------------------------------------------
// Search functions
// ---------------------------------------------------------------------------

export async function med103DoctorSearch(
  specialty: string,
  params: { city?: string; page?: number; sort_order?: string },
  deps: WebDeps = {},
): Promise<string> {
  const url = buildDoctorUrl(specialty, params);
  const timeoutMs = deps.timeoutMs ?? FETCH_LIMITS.timeoutMs;
  const started = Date.now();
  try {
    const md = await fetchPageAsMarkdown(url, timeoutMs, {
      fetchFn: deps.fetchFn,
      pageParsers: med103PageParsers,
    });
    log.debug(
      { specialty, city: params.city, url, elapsedMs: Date.now() - started },
      "med103: doctor search",
    );
    return md;
  } catch (err) {
    log.warn(
      { specialty, city: params.city, url, err: (err as Error).message },
      "med103: doctor search failed",
    );
    throw err;
  }
}

export async function med103ClinicSearch(
  path: string,
  params: { city?: string; page?: number },
  deps: WebDeps = {},
): Promise<string> {
  const url = buildClinicUrl(path, params);
  const timeoutMs = deps.timeoutMs ?? FETCH_LIMITS.timeoutMs;
  const started = Date.now();
  try {
    const md = await fetchPageAsMarkdown(url, timeoutMs, {
      fetchFn: deps.fetchFn,
      pageParsers: med103PageParsers,
    });
    log.debug(
      { path, city: params.city, url, elapsedMs: Date.now() - started },
      "med103: clinic search",
    );
    return md;
  } catch (err) {
    log.warn(
      { path, city: params.city, url, err: (err as Error).message },
      "med103: clinic search failed",
    );
    throw err;
  }
}

export async function med103ServiceSearch(
  service: string,
  params: { city?: string },
  deps: WebDeps = {},
): Promise<string> {
  const url = buildServiceUrl(service, params);
  const timeoutMs = deps.timeoutMs ?? FETCH_LIMITS.timeoutMs;
  const started = Date.now();
  try {
    const md = await fetchPageAsMarkdown(url, timeoutMs, {
      fetchFn: deps.fetchFn,
      pageParsers: med103PageParsers,
    });
    log.debug(
      { service, city: params.city, url, elapsedMs: Date.now() - started },
      "med103: service search",
    );
    return md;
  } catch (err) {
    log.warn(
      { service, city: params.city, url, err: (err as Error).message },
      "med103: service search failed",
    );
    throw err;
  }
}

export async function med103PharmacySearch(
  medicine: string,
  deps: WebDeps = {},
): Promise<string> {
  const url = buildPharmacyUrl(medicine);
  const timeoutMs = deps.timeoutMs ?? FETCH_LIMITS.timeoutMs;
  const started = Date.now();
  try {
    const md = await fetchPageAsMarkdown(url, timeoutMs, {
      fetchFn: deps.fetchFn,
      pageParsers: med103PageParsers,
    });
    log.debug(
      { medicine, url, elapsedMs: Date.now() - started },
      "med103: pharmacy search",
    );
    return md;
  } catch (err) {
    log.warn(
      { medicine, url, err: (err as Error).message },
      "med103: pharmacy search failed",
    );
    throw err;
  }
}
