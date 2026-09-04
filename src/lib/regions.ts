/**
 * Where to search.
 *
 * A region search must not be one giant shallow query — asking for "100 joiners
 * in Perthshire" returns the same handful of Perth firms padded out. Instead a
 * region resolves to the real towns inside it, and the search sweeps them in
 * rounds, so a hundred prospects genuinely come from across the area.
 *
 * The geography is hardcoded on purpose: it is stable, free, deterministic and
 * testable, where asking the model "what towns are in Perthshire?" would cost an
 * API call per search and could answer differently each time. A region typed in
 * by hand that is not on this list still works — it searches the named area
 * directly over several rounds instead.
 */

export const LOCATION_TYPES = ["Town", "City", "District / Region", "Scotland"] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const QUANTITY_OPTIONS = [25, 50, 100] as const;
export type Quantity = (typeof QUANTITY_OPTIONS)[number];

/**
 * Districts and regions, each as the towns worth searching inside it, roughly
 * largest first so the best-populated places are covered before the hamlets.
 */
export const REGIONS: Record<string, string[]> = {
  Perthshire: [
    "Perth",
    "Crieff",
    "Blairgowrie",
    "Pitlochry",
    "Auchterarder",
    "Aberfeldy",
    "Scone",
    "Coupar Angus",
    "Alyth",
    "Dunkeld",
    "Comrie",
    "Methven",
    "Bridge of Earn",
    "Stanley",
    "Abernethy",
    "Errol",
    "Dunning",
    "Muthill",
    "Blair Atholl",
    "Bankfoot",
  ],
  "Kinross-shire": ["Kinross", "Milnathort", "Glenfarg", "Kelty", "Scotlandwell"],
  Angus: [
    "Arbroath",
    "Forfar",
    "Montrose",
    "Brechin",
    "Carnoustie",
    "Kirriemuir",
    "Monifieth",
    "Edzell",
    "Friockheim",
    "Letham",
  ],
  Fife: [
    "Dunfermline",
    "Kirkcaldy",
    "Glenrothes",
    "St Andrews",
    "Cupar",
    "Leven",
    "Cowdenbeath",
    "Rosyth",
    "Dalgety Bay",
    "Burntisland",
    "Anstruther",
    "Lochgelly",
    "Inverkeithing",
    "Kinghorn",
    "Newport-on-Tay",
    "Auchtermuchty",
  ],
  Stirlingshire: [
    "Stirling",
    "Dunblane",
    "Bridge of Allan",
    "Callander",
    "Bannockburn",
    "Doune",
    "Aberfoyle",
    "Balfron",
    "Drymen",
    "Killin",
  ],
  Clackmannanshire: ["Alloa", "Tillicoultry", "Alva", "Tullibody", "Sauchie", "Dollar", "Menstrie", "Clackmannan"],
  "Dundee & Broughty Ferry": ["Dundee", "Broughty Ferry", "Monifieth", "Invergowrie", "Newport-on-Tay"],
  Aberdeenshire: [
    "Aberdeen",
    "Peterhead",
    "Fraserburgh",
    "Inverurie",
    "Stonehaven",
    "Ellon",
    "Westhill",
    "Banchory",
    "Turriff",
    "Huntly",
  ],
  Moray: ["Elgin", "Forres", "Buckie", "Keith", "Lossiemouth", "Aberlour", "Dufftown"],
  Highlands: [
    "Inverness",
    "Fort William",
    "Nairn",
    "Dingwall",
    "Alness",
    "Invergordon",
    "Aviemore",
    "Wick",
    "Thurso",
    "Ullapool",
    "Kingussie",
    "Grantown-on-Spey",
  ],
  Argyll: ["Oban", "Dunoon", "Helensburgh", "Campbeltown", "Lochgilphead", "Rothesay", "Inveraray", "Tarbert"],
  Ayrshire: [
    "Ayr",
    "Kilmarnock",
    "Irvine",
    "Prestwick",
    "Troon",
    "Largs",
    "Saltcoats",
    "Kilwinning",
    "Cumnock",
    "Girvan",
  ],
  Lanarkshire: [
    "Hamilton",
    "East Kilbride",
    "Motherwell",
    "Cumbernauld",
    "Coatbridge",
    "Airdrie",
    "Wishaw",
    "Lanark",
    "Bellshill",
    "Rutherglen",
  ],
  Renfrewshire: ["Paisley", "Renfrew", "Johnstone", "Erskine", "Greenock", "Port Glasgow", "Barrhead", "Bishopton"],
  Dunbartonshire: ["Dumbarton", "Clydebank", "Bearsden", "Milngavie", "Kirkintilloch", "Alexandria", "Helensburgh"],
  "Lothian & Edinburgh": [
    "Edinburgh",
    "Livingston",
    "Musselburgh",
    "Dalkeith",
    "Bathgate",
    "Penicuik",
    "Haddington",
    "Linlithgow",
    "Bonnyrigg",
    "North Berwick",
  ],
  Falkirk: ["Falkirk", "Grangemouth", "Larbert", "Denny", "Bo'ness", "Stenhousemuir", "Bonnybridge"],
  "Scottish Borders": ["Galashiels", "Hawick", "Peebles", "Selkirk", "Kelso", "Jedburgh", "Duns", "Eyemouth"],
  "Dumfries & Galloway": ["Dumfries", "Stranraer", "Annan", "Castle Douglas", "Lockerbie", "Newton Stewart", "Kirkcudbright"],
};

/**
 * Cities, as the city plus its distinct areas. A city has plenty of businesses
 * but one query only ever surfaces the same top listings, so the sweep uses
 * neighbourhoods and satellite towns to reach genuinely different firms.
 */
export const CITIES: Record<string, string[]> = {
  Perth: ["Perth", "Scone", "Bridge of Earn", "Methven", "Almondbank", "Luncarty"],
  Dundee: ["Dundee", "Broughty Ferry", "Lochee", "Monifieth", "Invergowrie", "Downfield", "Menzieshill"],
  Stirling: ["Stirling", "Bannockburn", "Bridge of Allan", "Dunblane", "Cambusbarron", "Fallin"],
  Edinburgh: ["Edinburgh", "Leith", "Portobello", "Corstorphine", "Morningside", "Currie", "Musselburgh", "Dalkeith"],
  Glasgow: ["Glasgow", "Shawlands", "Dennistoun", "Partick", "Govan", "Rutherglen", "Bearsden", "Paisley"],
  Aberdeen: ["Aberdeen", "Dyce", "Bridge of Don", "Cults", "Westhill", "Portlethen"],
  Inverness: ["Inverness", "Culloden", "Nairn", "Beauly", "Dingwall", "Muir of Ord"],
  Dunfermline: ["Dunfermline", "Rosyth", "Inverkeithing", "Dalgety Bay", "Crossford"],
};

/**
 * A whole-country sweep: the biggest population centres first, so a Scotland
 * search spends its budget where the businesses actually are.
 */
export const SCOTLAND_AREAS: string[] = [
  "Glasgow",
  "Edinburgh",
  "Aberdeen",
  "Dundee",
  "Perth",
  "Stirling",
  "Inverness",
  "Paisley",
  "Falkirk",
  "Livingston",
  "Kirkcaldy",
  "Dunfermline",
  "Ayr",
  "Kilmarnock",
  "Hamilton",
  "East Kilbride",
  "Cumbernauld",
  "Greenock",
  "Motherwell",
  "Elgin",
  "Dumfries",
  "Galashiels",
  "Oban",
  "Fort William",
];

/** Region and city names, for the picker. */
export const REGION_NAMES = Object.keys(REGIONS);
export const CITY_NAMES = Object.keys(CITIES);

/** Case- and punctuation-insensitive lookup, so "perth shire" finds Perthshire. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * What people actually type, mapped to the key above. Council and colloquial
 * names differ from the traditional county names used as keys — "Perth &
 * Kinross" is the council, "Perthshire" is the county, and a search for either
 * should sweep the same towns.
 */
const ALIASES: Record<string, string> = {
  perthkinross: "Perthshire",
  perthandkinross: "Perthshire",
  tayside: "Perthshire",
  strathearn: "Perthshire",
  dumfriesandgalloway: "Dumfries & Galloway",
  lothian: "Lothian & Edinburgh",
  lothians: "Lothian & Edinburgh",
  eastlothian: "Lothian & Edinburgh",
  midlothian: "Lothian & Edinburgh",
  westlothian: "Lothian & Edinburgh",
  forthvalley: "Stirlingshire",
  thehighlands: "Highlands",
  highland: "Highlands",
  argyllandbute: "Argyll",
  argyllbute: "Argyll",
  northayrshire: "Ayrshire",
  southayrshire: "Ayrshire",
  eastayrshire: "Ayrshire",
  northlanarkshire: "Lanarkshire",
  southlanarkshire: "Lanarkshire",
};

function lookup(table: Record<string, string[]>, name: string): string[] | null {
  const wanted = normalize(name);
  if (!wanted) return null;

  const aliased = ALIASES[wanted];
  if (aliased && table[aliased]) return table[aliased];

  for (const [key, areas] of Object.entries(table)) {
    if (normalize(key) === wanted) return areas;
  }
  // Looser second pass, so "Perth" as a region finds Perthshire. Guarded by a
  // minimum length: two or three letters would match almost anything.
  if (wanted.length >= 4) {
    for (const [key, areas] of Object.entries(table)) {
      const k = normalize(key);
      if (k.includes(wanted) || wanted.includes(k)) return areas;
    }
  }
  return null;
}

export type SearchPlan = {
  /** Places to search, in order. Always at least one entry. */
  areas: string[];
  /** The wider area named in the prompt, e.g. "Perthshire". Empty for a plain town. */
  context: string;
  /** True when the plan sweeps several places rather than drilling one. */
  wide: boolean;
  /** True when a region/city was asked for but is not in the table above. */
  unknownArea: boolean;
};

/**
 * Turn "Perthshire, District / Region" into the list of places to sweep.
 *
 * An unrecognised region is not an error: it searches the named area directly
 * over several rounds, which is what the old single-town search did anyway.
 */
export function planSearch(locationType: LocationType, location: string): SearchPlan {
  const name = location.trim();
  if (!name) return { areas: [], context: "", wide: false, unknownArea: false };

  if (locationType === "Scotland") {
    return { areas: SCOTLAND_AREAS, context: "Scotland", wide: true, unknownArea: false };
  }

  if (locationType === "District / Region") {
    const areas = lookup(REGIONS, name);
    if (areas) return { areas, context: name, wide: true, unknownArea: false };
    return { areas: [name], context: name, wide: false, unknownArea: true };
  }

  if (locationType === "City") {
    const areas = lookup(CITIES, name);
    if (areas) return { areas, context: name, wide: true, unknownArea: false };
    return { areas: [name], context: name, wide: false, unknownArea: true };
  }

  return { areas: [name], context: "", wide: false, unknownArea: false };
}

export type SearchBatch = {
  /** The place this call searches. */
  area: string;
  /** Wider area for the prompt, or "". */
  context: string;
  /** Which pass over the area list this is (0-based). */
  round: number;
};

/** How many businesses one API call asks for. More per call = fewer calls. */
export const MAX_PER_BATCH = 12;
const MIN_PER_BATCH = 4;

/**
 * The call budget for a target.
 *
 * Every batch is real money, so this is deliberately finite: enough calls to
 * reach the target with room for the ones that come back thin, and no more. The
 * sweep also stops early when it hits the target or stops finding anything new.
 */
export function callBudget(target: number): number {
  return Math.min(24, Math.ceil(target / 6) + 3);
}

/** How many businesses to ask for, given how many are still wanted. */
export function batchSize(remaining: number): number {
  return Math.max(MIN_PER_BATCH, Math.min(MAX_PER_BATCH, remaining));
}

/**
 * The ordered queue of calls.
 *
 * Round-robin, not area-by-area: a search that stops early has then covered the
 * whole region shallowly rather than one town deeply, which is the point of
 * asking for a region in the first place.
 */
export function buildBatchQueue(plan: SearchPlan, target: number): SearchBatch[] {
  if (plan.areas.length === 0) return [];
  const budget = callBudget(target);
  const rounds = Math.max(1, Math.ceil(budget / plan.areas.length));
  const queue: SearchBatch[] = [];
  for (let round = 0; round < rounds && queue.length < budget; round += 1) {
    for (const area of plan.areas) {
      if (queue.length >= budget) break;
      queue.push({ area, context: plan.context, round });
    }
  }
  return queue;
}
