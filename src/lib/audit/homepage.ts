/**
 * Audit a homepage from its HTML and the HTTP exchange that fetched it.
 *
 * Deterministic and offline: given the same bytes it returns the same
 * findings, so every rule is unit-tested against fixtures. It reads only what
 * the page actually contains — a check it cannot perform reliably (a
 * JavaScript-rendered page, an ambiguous CMS fingerprint) is reported at lower
 * confidence or not at all, never as a fact.
 *
 * Client-safe and pure.
 */
import { decodeHtmlEntities } from "../html-entities.ts";
import { dateLabel, type Finding, type FindingSource } from "./findings.ts";

export type HomepageInput = {
  /** The address checked (what the listing or search gave us). */
  url: string;
  /** Where it ended up after redirects. */
  finalUrl: string;
  status: number;
  html: string;
  /** Time to the response, as measured from our server. */
  responseMs: number;
  /** Size of the HTML document itself (not images or scripts). */
  bytes: number;
  /** Each redirect hop, in order. */
  redirects: string[];
  business: { name: string; town: string; trade: string };
  observedAt: string;
  robots?: { found: boolean; disallowAll: boolean } | null;
  sitemap?: { found: boolean } | null;
  links?: { checked: number; broken: { url: string; status: number }[] } | null;
};

export type HomepageFacts = {
  https: boolean;
  status: number;
  title: string;
  metaDescription: string;
  h1: string[];
  viewport: boolean;
  canonical: string;
  noindex: boolean;
  schemaTypes: string[];
  localBusinessSchema: boolean;
  telLinks: number;
  phoneShown: boolean;
  mailtoLinks: number;
  enquiryForms: number;
  bookingSystems: string[];
  ctaText: string[];
  quoteCta: boolean;
  serviceLinks: number;
  internalLinks: number;
  testimonials: boolean;
  trustSignals: string[];
  socialLinks: string[];
  copyrightYear: number | null;
  words: number;
  mentionsTown: boolean;
  postcodeShown: boolean;
  technology: { name: string; confidence: "high" | "medium"; signal: string }[];
  mixedContent: number;
  imagesWithoutAlt: number;
  parked: boolean;
  /**
   * The HTML is an empty shell filled in by JavaScript. Content checks on it
   * would report missing things that a browser actually shows, so they are
   * skipped rather than guessed.
   */
  scriptRendered: boolean;
};

const PARKED =
  /coming soon|under construction|domain for sale|buy this domain|parked free|this domain is parked|website currently unavailable|account suspended|website is under maintenance/i;

const LOCAL_BUSINESS_TYPES =
  /^(LocalBusiness|ProfessionalService|HomeAndConstructionBusiness|GeneralContractor|RoofingContractor|Plumber|Electrician|HousePainter|Locksmith|MovingCompany|HVACBusiness|AutoRepair|AutomotiveBusiness|HairSalon|BeautySalon|NailSalon|DaySpa|HealthAndBeautyBusiness|Restaurant|CafeOrCoffeeShop|FoodEstablishment|BarOrPub|Store|Florist|PetStore|Dentist|MedicalBusiness|LegalService|AccountingService|FinancialService|RealEstateAgent|TravelAgency|ExerciseGym|SportsActivityLocation|LodgingBusiness|Hotel|BedAndBreakfast|ChildCare|DryCleaningOrLaundry|EmploymentAgency|EntertainmentBusiness|GovernmentOffice|InternetCafe|Library|RadioStation|RecyclingCenter|SelfStorage|ShoppingCenter|TouristInformationCenter)$/;

const BOOKING_SYSTEMS: [string, RegExp][] = [
  ["Calendly", /calendly\.com/i],
  ["Booksy", /booksy\.com/i],
  ["Fresha", /fresha\.com/i],
  ["Treatwell", /treatwell\.co\.uk|treatwell\.com/i],
  ["Timely", /gettimely\.com/i],
  ["SimplyBook.me", /simplybook\.(me|it)/i],
  ["Acuity", /acuityscheduling\.com/i],
  ["Square Appointments", /squareup\.com\/appointments|square\.site\/book/i],
  ["Setmore", /setmore\.com/i],
  ["OpenTable", /opentable\.co/i],
  ["ResDiary", /resdiary\.com/i],
  ["DesignMyNight", /designmynight\.com/i],
  ["Phorest", /phorest\.com/i],
  ["Salonized", /salonized\.com/i],
  ["Vagaro", /vagaro\.com/i],
  ["Mindbody", /mindbodyonline\.com/i],
  ["Bookwhen", /bookwhen\.com/i],
  ["Planity", /planity\.com/i],
];

const TECHNOLOGY: { name: string; high?: RegExp; medium?: RegExp }[] = [
  { name: "WordPress", high: /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress/i, medium: /\/wp-content\/|\/wp-includes\//i },
  { name: "Wix", high: /<meta[^>]+name=["']generator["'][^>]+content=["']Wix/i, medium: /static\.wixstatic\.com|static\.parastorage\.com/i },
  { name: "Squarespace", high: /<!-- This is Squarespace\. -->/i, medium: /static1\.squarespace\.com|squarespace-cdn\.com/i },
  { name: "Shopify", high: /cdn\.shopify\.com\/s\/files/i, medium: /myshopify\.com/i },
  { name: "Webflow", high: /<meta[^>]+name=["']generator["'][^>]+content=["']Webflow/i, medium: /data-wf-page=/i },
  { name: "GoDaddy Website Builder", high: /<meta[^>]+name=["']generator["'][^>]+content=["']Starfield Technologies/i, medium: /img1\.wsimg\.com/i },
  { name: "Weebly", medium: /weebly\.com\/|editmysite\.com/i },
  { name: "Jimdo", medium: /jimdo(free)?\.com|jimcdn\.com/i },
  { name: "Duda", medium: /dudamobile\.com|multiscreensite\.com|irp\.cdn-website\.com/i },
  { name: "IONOS MyWebsite", medium: /mywebsite-editor\.com|homepagebuilder\.1and1/i },
  { name: "Joomla", high: /<meta[^>]+name=["']generator["'][^>]+content=["']Joomla/i },
  { name: "Drupal", high: /<meta[^>]+name=["']generator["'][^>]+content=["']Drupal/i },
];

const TRUST_SIGNALS: [string, RegExp][] = [
  ["Gas Safe", /gas\s*safe/i],
  ["NICEIC", /niceic/i],
  ["NAPIT", /napit/i],
  ["Checkatrade", /checkatrade/i],
  ["TrustATrader", /trustatrader/i],
  ["Which? Trusted Trader", /which\?\s*trusted\s*trader/i],
  ["TrustMark", /trustmark/i],
  ["Federation of Master Builders", /federation of master builders|\bFMB\b/],
  ["Guild of Master Craftsmen", /guild of master craftsmen/i],
  ["Trustpilot", /trustpilot/i],
  ["Google reviews", /google reviews/i],
  ["Accredited", /\baccredited\b/i],
];

const SOCIAL: [string, RegExp][] = [
  ["Facebook", /facebook\.com\//i],
  ["Instagram", /instagram\.com\//i],
  ["LinkedIn", /linkedin\.com\//i],
  ["X / Twitter", /(?:twitter|x)\.com\//i],
  ["TikTok", /tiktok\.com\//i],
  ["YouTube", /youtube\.com\//i],
];

const BOOKING_TRADES = /hair|barber|beaut|salon|nail|spa|restaurant|cafe|café|bistro|groom|gym|fitness|physio|massage|tattoo|therap|clinic|dentist|yoga|pilates/i;
const QUOTE_TRADES =
  /build|roof|join|carpent|plumb|electric|paint|decorat|landscap|garden|tiler|tiling|floor|plaster|kitchen|bathroom|window|driveway|fenc|tree|clean|remov|heating|gas|lock|scaffold|glaz|renovat|extension|damp|insulat|solar|trade/i;

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[match[1]!.toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? "";
  }
  return out;
}

function textOf(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function visibleText(html: string): string {
  return textOf(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<(br|p|div|li|h[1-6]|section|footer|header)[^>]*>/gi, " "),
  );
}

function schemaTypesOf(html: string): string[] {
  const types = new Set<string>();
  const collect = (node: unknown, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) collect(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const type = record["@type"];
    for (const value of Array.isArray(type) ? type : [type]) if (typeof value === "string") types.add(value.replace(/^https?:\/\/schema\.org\//, ""));
    if (record["@graph"]) collect(record["@graph"], depth + 1);
  };
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      collect(JSON.parse(match[1]!.trim()));
    } catch {
      /* malformed JSON-LD is common; it simply does not count */
    }
  }
  for (const match of html.matchAll(/itemtype=["']https?:\/\/schema\.org\/([A-Za-z]+)["']/gi)) types.add(match[1]!);
  return [...types];
}

function sameSite(href: string, base: URL): URL | null {
  try {
    const url = new URL(href, base);
    if (!/^https?:$/.test(url.protocol)) return null;
    const strip = (host: string) => host.replace(/^www\./, "");
    return strip(url.hostname) === strip(base.hostname) ? url : null;
  } catch {
    return null;
  }
}

export function homepageFacts(input: HomepageInput, now: Date = new Date(input.observedAt)): HomepageFacts {
  const html = input.html ?? "";
  const text = visibleText(html);
  let base: URL;
  try {
    base = new URL(input.finalUrl || input.url);
  } catch {
    base = new URL("https://invalid.example/");
  }

  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => attrs(match[0]));
  const meta = (name: string) => metas.find((entry) => (entry.name ?? entry.property ?? "").toLowerCase() === name)?.content ?? "";
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => attrs(match[0]));
  const anchors: Record<string, string>[] = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => ({
    ...attrs(`<a ${match[1]}>`),
    text: textOf(match[2] ?? ""),
  }));
  const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)].map((match) => textOf(match[1] ?? ""));
  const hrefs = anchors.map((anchor) => (anchor.href ?? "").trim());

  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].filter((match) => {
    const formAttrs = attrs(`<form ${match[1]}>`);
    const body = match[2] ?? "";
    const search = /search/i.test(`${formAttrs.role ?? ""} ${formAttrs.action ?? ""} ${formAttrs.class ?? ""} ${formAttrs.id ?? ""}`) || /type=["']search["']/i.test(body);
    const collects = /<textarea|type=["']email["']|type=["']tel["']|name=["'][^"']*(message|enquiry|name|phone|email)/i.test(body);
    return !search && collects;
  });
  // Page builders render forms from scripts; their embed markers still show.
  const embeddedForm = /wpcf7|gform_wrapper|wpforms|ninja-forms|formspree\.io|typeform\.com|jotform|hsforms|forms\.office\.com|docs\.google\.com\/forms|wixforms|data-form-id|contact-form-7/i.test(html);

  const ctaPattern = /\b(contact us|get in touch|call (us|now|today)|enquire|enquiry|request a (call ?back|quote)|get a (free )?quote|free (quote|estimate|survey)|book (now|online|a table|an appointment|your)|make a booking)\b/i;
  const ctaText = [...new Set([...anchors.map((anchor) => anchor.text), ...buttons].filter((label) => label.length < 60 && ctaPattern.test(label)))].slice(0, 6);

  const internal = hrefs.map((href) => sameSite(href, base)).filter((url): url is URL => Boolean(url));
  const internalPaths = new Set(internal.map((url) => url.pathname.replace(/\/+$/, "") || "/"));
  const serviceLinks = [...internalPaths].filter((path) => /servic|what-we-do|our-work|roof|joiner|plumb|electri|kitchen|bathroom|extension|treatment|menu|price|gallery|projects|portfolio/i.test(path)).length;

  const years = [...text.matchAll(/(?:©|\(c\)|copyright)\s*(?:(?:19|20)\d{2}\s*[-–—]\s*)?((?:19|20)\d{2})/gi)].map((match) => Number(match[1]));
  const plausible = years.filter((year) => year >= 1995 && year <= now.getUTCFullYear() + 1);

  const technology: HomepageFacts["technology"] = [];
  for (const entry of TECHNOLOGY) {
    if (entry.high?.test(html)) technology.push({ name: entry.name, confidence: "high", signal: "generator tag or platform asset path" });
    else if (entry.medium?.test(html)) technology.push({ name: entry.name, confidence: "medium", signal: "platform asset hosts" });
  }

  const https = base.protocol === "https:";
  const schemaTypes = schemaTypesOf(html);
  const town = input.business.town.trim().toLowerCase();

  return {
    https,
    status: input.status,
    title: textOf((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").slice(0, 300)),
    metaDescription: meta("description").trim().slice(0, 400),
    h1: [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((match) => textOf(match[1] ?? "")).filter(Boolean).slice(0, 5),
    viewport: Boolean(meta("viewport")),
    canonical: links.find((link) => (link.rel ?? "").toLowerCase() === "canonical")?.href ?? "",
    noindex: /noindex/i.test(meta("robots")) || /noindex/i.test(meta("googlebot")),
    schemaTypes,
    localBusinessSchema: schemaTypes.some((type) => LOCAL_BUSINESS_TYPES.test(type)) || /schema\.org\/LocalBusiness/i.test(html),
    telLinks: hrefs.filter((href) => /^tel:/i.test(href)).length,
    phoneShown: /(?:\+44\s?\(?0?\)?\s?|\b0)(?:\d\s?){9,10}\b/.test(text),
    mailtoLinks: hrefs.filter((href) => /^mailto:/i.test(href)).length,
    enquiryForms: forms.length + (forms.length === 0 && embeddedForm ? 1 : 0),
    bookingSystems: BOOKING_SYSTEMS.filter(([, pattern]) => pattern.test(html)).map(([name]) => name),
    ctaText,
    quoteCta: /\b(get a (free )?quote|request a quote|free (quote|estimate|survey)|quotation)\b/i.test(text),
    serviceLinks,
    internalLinks: internalPaths.size,
    testimonials: /testimonial|what our (customers|clients) say|customer reviews|client reviews|★★★|5 stars|five stars|trustpilot|checkatrade|google reviews/i.test(text),
    trustSignals: TRUST_SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name),
    socialLinks: SOCIAL.filter(([, pattern]) => hrefs.some((href) => pattern.test(href))).map(([name]) => name),
    copyrightYear: plausible.length ? Math.max(...plausible) : null,
    words: text ? text.split(/\s+/).filter((word) => /[a-z]/i.test(word)).length : 0,
    mentionsTown: town.length > 2 && text.toLowerCase().includes(town),
    postcodeShown: /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/.test(text),
    technology,
    mixedContent: https ? [...html.matchAll(/<(?:script|img|link|iframe)\b[^>]+(?:src|href)=["']http:\/\//gi)].length : 0,
    imagesWithoutAlt: [...html.matchAll(/<img\b[^>]*>/gi)].filter((match) => !/\balt\s*=/i.test(match[0])).length,
    parked: PARKED.test(text.slice(0, 3000)) && text.length < 3000,
    scriptRendered:
      text.split(/\s+/).filter(Boolean).length < 60 &&
      (/<div[^>]+id=["'](root|app|__next|__nuxt|___gatsby)["'][^>]*>\s*<\/div>/i.test(html) ||
        [...html.matchAll(/<script\b/gi)].length >= 5),
  };
}

/** Everything the homepage checks found, measured and dated. */
export function auditHomepage(input: HomepageInput): { facts: HomepageFacts; findings: Finding[] } {
  const facts = homepageFacts(input);
  const when = dateLabel(input.observedAt);
  const url = input.finalUrl || input.url;
  const findings: Finding[] = [];
  const add = (finding: Omit<Finding, "url" | "observedAt" | "source"> & { source?: FindingSource; url?: string }) =>
    findings.push({ source: "homepage", url, observedAt: input.observedAt, ...finding });
  const trade = input.business.trade;

  // ── Technical: can the page be reached at all? ─────────────────────────────
  if (input.status >= 400) {
    add({
      kind: "http_error",
      category: "technical",
      status: "opportunity",
      impact: 9,
      title: "Homepage returns an error",
      evidence: `The homepage returned HTTP ${input.status} when checked on ${when}.`,
      why: "Anyone following a link or a Google result sees an error page instead of the business.",
      value: String(input.status),
      source: "http",
      confidence: "high",
    });
    return { facts, findings };
  }
  if (facts.parked) {
    add({
      kind: "parked",
      category: "technical",
      status: "opportunity",
      impact: 9,
      title: "Holding page, not a website",
      evidence: `The homepage shows a holding page (“coming soon” / “under construction” wording) on ${when}.`,
      why: "The domain exists but does no work for the business.",
      value: "parked",
      confidence: "medium",
    });
  }

  add(
    facts.https
      ? { kind: "https", category: "technical", status: "ok", impact: 0, title: "Secure (HTTPS)", evidence: "The site loads over HTTPS.", why: "", value: "true", source: "http", confidence: "high" }
      : {
          kind: "no_https",
          category: "technical",
          status: "opportunity",
          impact: 6,
          title: "Not secure (no HTTPS)",
          evidence: `The site loaded over plain HTTP (${url}) on ${when}, which browsers label “Not secure”.`,
          why: "A “Not secure” warning puts people off before they read anything.",
          value: "false",
          source: "http",
          confidence: "high",
        },
  );

  const seconds = (input.responseMs / 1000).toFixed(1);
  if (input.responseMs >= 3000) {
    add({
      kind: "slow_response",
      category: "performance",
      status: "opportunity",
      impact: 3,
      title: "Slow to respond",
      evidence: `The homepage took ${seconds} s to respond when we checked on ${when} (one measurement, from our server).`,
      why: "Slow first responses lose impatient mobile visitors.",
      value: String(input.responseMs),
      source: "http",
      confidence: "low",
    });
  }
  if (input.redirects.length > 2) {
    add({
      kind: "redirect_chain",
      category: "technical",
      status: "info",
      impact: 0,
      title: "Several redirects",
      evidence: `The address redirected ${input.redirects.length} times before the homepage loaded.`,
      why: "Each hop adds delay.",
      value: String(input.redirects.length),
      source: "http",
      confidence: "high",
    });
  }
  if (facts.mixedContent > 0) {
    add({
      kind: "mixed_content",
      category: "technical",
      status: "opportunity",
      impact: 2,
      title: "Insecure content on a secure page",
      evidence: `${facts.mixedContent} script, image or stylesheet reference${facts.mixedContent === 1 ? " loads" : "s load"} over plain HTTP on the HTTPS homepage.`,
      why: "Browsers block or warn about mixed content.",
      value: String(facts.mixedContent),
      confidence: "high",
    });
  }
  if (input.links && input.links.broken.length > 0) {
    add({
      kind: "broken_links",
      category: "technical",
      status: "opportunity",
      impact: 4,
      title: "Broken links",
      evidence: `${input.links.broken.length} of ${input.links.checked} links checked on the homepage led to an error page (e.g. ${input.links.broken[0]!.url} → HTTP ${input.links.broken[0]!.status}).`,
      why: "Dead links make a site look abandoned.",
      value: String(input.links.broken.length),
      source: "link-check",
      url: input.links.broken[0]!.url,
      confidence: "high",
    });
  }

  if (facts.scriptRendered) {
    add({
      kind: "script_rendered",
      category: "technical",
      status: "info",
      impact: 0,
      title: "Content loads by JavaScript",
      evidence: "The homepage's content is built by JavaScript after it loads, so the content checks below could not read it. PageSpeed (which renders the page) is the reliable measure here.",
      why: "",
      value: "true",
      confidence: "medium",
    });
  }
  const readable = !facts.scriptRendered;

  // ── Mobile, from the HTML ──────────────────────────────────────────────────
  if (!facts.viewport) {
    add({
      kind: "no_viewport",
      category: "performance",
      status: "opportunity",
      impact: 7,
      title: "Not set up for phones",
      evidence: "The homepage has no mobile viewport tag, so phones show a shrunken desktop page.",
      why: "Most local searches happen on a phone.",
      value: "false",
      confidence: "high",
    });
  }

  // ── Conversion: can a visitor become an enquiry? ───────────────────────────
  // Checks on page content only mean something when the content is in the HTML.
  if (readable) {
    if (facts.telLinks === 0) {
      add(
        facts.phoneShown
          ? {
              kind: "phone_not_tappable",
              category: "conversion",
              status: "opportunity",
              impact: 4,
              title: "Phone number can't be tapped",
              evidence: "A phone number is shown on the homepage, but not as a tap-to-call link.",
              why: "On a phone, a tap-to-call link turns interest into a call in one step.",
              value: "0",
              confidence: "high",
            }
          : {
              kind: "no_phone",
              category: "conversion",
              status: "opportunity",
              impact: 5,
              title: "No phone number on the homepage",
              evidence: "No phone number or tap-to-call link was found on the homepage.",
              why: "Local customers often want to ring straight away.",
              value: "0",
              confidence: "medium",
            },
      );
    } else {
      add({ kind: "tap_to_call", category: "conversion", status: "ok", impact: 0, title: "Tap-to-call", evidence: "The phone number is a tap-to-call link.", why: "", value: String(facts.telLinks), confidence: "high" });
    }

    if (facts.enquiryForms === 0 && facts.bookingSystems.length === 0) {
      add({
        kind: "no_enquiry_form",
        category: "conversion",
        status: "opportunity",
        impact: facts.mailtoLinks > 0 ? 4 : 5,
        title: "No enquiry form",
        evidence: `No enquiry form or booking widget was found on the homepage${facts.mailtoLinks > 0 ? " (there is an email link)" : ""}.`,
        why: "A form captures enquiries out of hours, when nobody answers the phone.",
        value: "0",
        confidence: "medium",
      });
    } else if (facts.enquiryForms > 0) {
      add({ kind: "enquiry_form", category: "conversion", status: "ok", impact: 0, title: "Enquiry form", evidence: "The homepage has an enquiry form.", why: "", value: String(facts.enquiryForms), confidence: "medium" });
    }

    if (facts.ctaText.length === 0) {
      add({
        kind: "no_cta",
        category: "conversion",
        status: "opportunity",
        impact: 4,
        title: "No clear call to action",
        evidence: "No “Get a quote”, “Contact us”, “Book now” or similar button or link was found on the homepage.",
        why: "Visitors who aren't told what to do next usually leave.",
        value: "0",
        confidence: "medium",
      });
    }

    if (BOOKING_TRADES.test(trade)) {
      add(
        facts.bookingSystems.length
          ? { kind: "online_booking", category: "conversion", status: "ok", impact: 0, title: "Online booking", evidence: `Online booking via ${facts.bookingSystems.join(", ")}.`, why: "", value: facts.bookingSystems.join(", "), confidence: "high" }
          : {
              kind: "no_online_booking",
              category: "conversion",
              status: "opportunity",
              impact: 5,
              title: "No online booking",
              evidence: "No online booking system (Fresha, Booksy, Treatwell, Calendly and others) was detected on the homepage.",
              why: `For a ${trade.toLowerCase()}, bookings that can be made at 11pm are bookings a competitor doesn't get.`,
              value: "none",
              confidence: "medium",
            },
      );
    }
    if (QUOTE_TRADES.test(trade) && !facts.quoteCta) {
      add({
        kind: "no_quote_request",
        category: "conversion",
        status: "opportunity",
        impact: 4,
        title: "No quote request",
        evidence: "Nothing on the homepage invites a visitor to ask for a quote.",
        why: "For trades, “get a free quote” is the enquiry.",
        value: "false",
        confidence: "medium",
      });
    }

    // ── Trust ──────────────────────────────────────────────────────────────────
    if (!facts.testimonials) {
      add({
        kind: "no_testimonials",
        category: "trust",
        status: "opportunity",
        impact: 3,
        title: "No reviews or testimonials shown",
        evidence: "No testimonials, star ratings or review-site widgets were found on the homepage.",
        why: "Local customers look for proof that others were happy.",
        value: "false",
        confidence: "medium",
      });
    } else {
      add({ kind: "testimonials", category: "trust", status: "ok", impact: 0, title: "Reviews shown", evidence: "The homepage shows testimonials or reviews.", why: "", value: "true", confidence: "medium" });
    }
    if (facts.trustSignals.length) {
      add({ kind: "trust_signals", category: "trust", status: "ok", impact: 0, title: "Accreditations", evidence: `Mentions ${facts.trustSignals.join(", ")}.`, why: "", value: facts.trustSignals.join(", "), confidence: "medium" });
    }
    const year = new Date(input.observedAt).getUTCFullYear();
    if (facts.copyrightYear !== null && facts.copyrightYear <= year - 2) {
      add({
        kind: "stale_copyright",
        category: "trust",
        status: "opportunity",
        impact: facts.copyrightYear <= year - 3 ? 4 : 2,
        title: "Out-of-date footer",
        evidence: `The homepage copyright notice says ${facts.copyrightYear}.`,
        why: "An old year makes visitors wonder whether the business is still trading.",
        value: String(facts.copyrightYear),
        confidence: "high",
      });
    }
    if (!facts.postcodeShown) {
      add({
        kind: "no_address",
        category: "trust",
        status: "opportunity",
        impact: 2,
        title: "No address shown",
        evidence: "No postcode was found in the homepage text.",
        why: "An address reassures people the business is real and local.",
        value: "false",
        confidence: "medium",
      });
    }
    if (facts.socialLinks.length) {
      add({ kind: "social_links", category: "trust", status: "info", impact: 0, title: "Social profiles", evidence: `Links to ${facts.socialLinks.join(", ")}.`, why: "", value: facts.socialLinks.join(", "), confidence: "high" });
    }

    // ── SEO foundations ────────────────────────────────────────────────────────
    if (!facts.title) {
      add({ kind: "no_title", category: "seo", status: "opportunity", impact: 5, title: "No page title", evidence: "The homepage has no page title, which is what Google shows as the link.", why: "Google has nothing good to show in results.", value: "", confidence: "high" });
    } else if (facts.title.length < 12 || /^(home|homepage|welcome|untitled|index)$/i.test(facts.title.trim())) {
      add({ kind: "weak_title", category: "seo", status: "opportunity", impact: 3, title: "Generic page title", evidence: `The homepage title is just “${facts.title}”.`, why: "The title is the headline in Google results.", value: facts.title, confidence: "high" });
    } else {
      add({ kind: "title", category: "seo", status: "ok", impact: 0, title: "Page title", evidence: `Title: “${facts.title.slice(0, 90)}”.`, why: "", value: facts.title, confidence: "high" });
    }
    if (!facts.metaDescription) {
      add({ kind: "no_meta_description", category: "seo", status: "opportunity", impact: 3, title: "No search description", evidence: "The homepage has no meta description, so Google picks its own snippet.", why: "A written description earns more clicks.", value: "", confidence: "high" });
    }
    if (facts.h1.length === 0) {
      add({ kind: "no_h1", category: "seo", status: "opportunity", impact: 3, title: "No main heading", evidence: "The homepage has no main (H1) heading.", why: "The main heading tells visitors and Google what the business does.", value: "0", confidence: "high" });
    }
    if (!facts.localBusinessSchema) {
      add({ kind: "no_local_schema", category: "seo", status: "opportunity", impact: 2, title: "No local business data", evidence: "No LocalBusiness structured data (schema.org) was found on the homepage.", why: "Structured data helps Google show hours, reviews and location.", value: facts.schemaTypes.join(", ") || "none", confidence: "high" });
    }
    if (input.business.town.trim() && !facts.mentionsTown) {
      add({ kind: "no_location", category: "seo", status: "opportunity", impact: 3, title: "Town not mentioned", evidence: `The homepage text doesn't mention ${input.business.town}.`, why: "Local searches match on place names.", value: input.business.town, confidence: "medium" });
    }
    if (facts.words < 250 && !facts.parked) {
      add({ kind: "thin_content", category: "seo", status: "opportunity", impact: 4, title: "Very little text", evidence: `The homepage has about ${facts.words} words of text.`, why: "Too little text gives Google and visitors little to go on.", value: String(facts.words), confidence: "medium" });
    }
    if (facts.serviceLinks === 0 && facts.internalLinks <= 3) {
      add({ kind: "no_service_pages", category: "seo", status: "opportunity", impact: 3, title: "No service pages", evidence: `The homepage links to ${facts.internalLinks} other page${facts.internalLinks === 1 ? "" : "s"} and none about specific services.`, why: "A page per service is how people searching for that service find you.", value: String(facts.internalLinks), confidence: "medium" });
    }
  }

  // ── Markup checks that hold however the page is rendered ───────────────────
  if (facts.noindex) {
    add({ kind: "noindex", category: "seo", status: "opportunity", impact: 7, title: "Hidden from Google", evidence: "The homepage tells search engines not to index it (robots “noindex”).", why: "The site cannot appear in Google at all.", value: "noindex", confidence: "high" });
  }
  if (input.robots && !input.robots.found) {
    add({ kind: "no_robots", category: "seo", status: "info", impact: 0, title: "No robots.txt", evidence: "The site has no robots.txt file.", why: "", value: "missing", source: "robots.txt", confidence: "high" });
  }
  if (input.robots?.disallowAll) {
    add({ kind: "robots_blocks_all", category: "seo", status: "opportunity", impact: 7, title: "Search engines blocked", evidence: "robots.txt blocks all search engines from the whole site.", why: "The site cannot appear in Google.", value: "Disallow: /", source: "robots.txt", confidence: "high" });
  }
  if (input.sitemap && !input.sitemap.found) {
    add({ kind: "no_sitemap", category: "seo", status: "info", impact: 0, title: "No sitemap", evidence: "No sitemap.xml was found.", why: "", value: "missing", source: "sitemap", confidence: "high" });
  }

  // ── Technology ─────────────────────────────────────────────────────────────
  for (const tech of facts.technology.slice(0, 2)) {
    add({
      kind: "technology",
      category: "technology",
      status: "info",
      impact: 0,
      title: `Built with ${tech.name}`,
      evidence: `${tech.confidence === "high" ? "Built with" : "Probably built with"} ${tech.name} (detected from ${tech.signal}).`,
      why: "",
      value: tech.name,
      confidence: tech.confidence,
    });
  }

  return { facts, findings };
}
