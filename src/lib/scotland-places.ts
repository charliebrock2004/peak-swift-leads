/**
 * How a typed location fans out into real town searches.
 *
 * Large / regional Find-leads jobs must not fire one "joiners in Perthshire"
 * request. They search the constituent towns, then the caller merges.
 */

export type PlaceKind = "town" | "city" | "region" | "nation";

export type SearchArea = {
  name: string;
  quota: number;
};

export type ResearchPlan = {
  kind: PlaceKind;
  label: string;
  areas: SearchArea[];
};

/** UI chips for the Region location type. */
export const REGION_SUGGESTIONS = [
  "Perthshire",
  "Fife",
  "Angus",
  "Stirlingshire",
  "Tayside",
  "Lothian",
  "Lanarkshire",
  "Ayrshire",
  "Aberdeenshire",
  "Highlands",
  "Borders",
  "Dumfries and Galloway",
  "Moray",
] as const;

export const CITY_SUGGESTIONS = [
  "Aberdeen",
  "Dundee",
  "Edinburgh",
  "Glasgow",
  "Inverness",
  "Perth",
  "Stirling",
  "Paisley",
  "Dunfermline",
  "Kilmarnock",
  "Livingston",
  "Ayr",
] as const;

type PlaceEntry = {
  name: string;
  aliases: string[];
  towns: string[];
};

const REGIONS: PlaceEntry[] = [
  {
    name: "Perthshire",
    aliases: ["perthshire", "perth and kinross", "perth & kinross", "perth and kinross council"],
    towns: [
      "Perth",
      "Crieff",
      "Auchterarder",
      "Pitlochry",
      "Blairgowrie",
      "Aberfeldy",
      "Kinross",
      "Comrie",
      "Dunkeld",
      "Scone",
      "Alyth",
      "Coupar Angus",
      "Bridge of Earn",
      "Blair Atholl",
      "Muthill",
      "Blackford",
      "Dunning",
      "Methven",
      "Stanley",
      "Abernethy",
    ],
  },
  {
    name: "Fife",
    aliases: ["fife", "kingdom of fife"],
    towns: [
      "Dunfermline",
      "Kirkcaldy",
      "Glenrothes",
      "St Andrews",
      "Cupar",
      "Leven",
      "Cowdenbeath",
      "Anstruther",
      "Lochgelly",
      "Burntisland",
      "Inverkeithing",
      "Dalgety Bay",
    ],
  },
  {
    name: "Angus",
    aliases: ["angus", "forfarshire"],
    towns: ["Forfar", "Arbroath", "Montrose", "Brechin", "Kirriemuir", "Carnoustie", "Monifieth", "Friockheim"],
  },
  {
    name: "Stirlingshire",
    aliases: ["stirlingshire", "stirling council", "stirling area"],
    towns: [
      "Stirling",
      "Dunblane",
      "Bridge of Allan",
      "Callander",
      "Bannockburn",
      "Doune",
      "Aberfoyle",
      "Balfron",
      "Fallin",
    ],
  },
  {
    name: "Tayside",
    aliases: ["tayside"],
    towns: [
      "Dundee",
      "Perth",
      "Arbroath",
      "Forfar",
      "Crieff",
      "Montrose",
      "Blairgowrie",
      "Carnoustie",
      "Auchterarder",
      "Kirriemuir",
    ],
  },
  {
    name: "Lothian",
    aliases: ["lothian", "west lothian", "east lothian", "midlothian", "the lothians"],
    towns: [
      "Edinburgh",
      "Livingston",
      "Linlithgow",
      "Bathgate",
      "Dalkeith",
      "Musselburgh",
      "Penicuik",
      "Haddington",
      "Tranent",
      "Broxburn",
      "Bonnyrigg",
    ],
  },
  {
    name: "Lanarkshire",
    aliases: ["lanarkshire", "north lanarkshire", "south lanarkshire"],
    towns: [
      "Hamilton",
      "Motherwell",
      "Coatbridge",
      "Airdrie",
      "East Kilbride",
      "Wishaw",
      "Lanark",
      "Bellshill",
      "Cumbernauld",
      "Rutherglen",
    ],
  },
  {
    name: "Ayrshire",
    aliases: ["ayrshire", "north ayrshire", "south ayrshire", "east ayrshire"],
    towns: ["Ayr", "Kilmarnock", "Irvine", "Troon", "Prestwick", "Saltcoats", "Largs", "Kilwinning", "Ardrossan", "Girvan"],
  },
  {
    name: "Aberdeenshire",
    aliases: ["aberdeenshire", "aberdeen shire"],
    towns: ["Aberdeen", "Peterhead", "Fraserburgh", "Inverurie", "Stonehaven", "Ellon", "Banchory", "Westhill", "Portlethen"],
  },
  {
    name: "Highlands",
    aliases: ["highlands", "highland", "the highlands", "highland council"],
    towns: ["Inverness", "Fort William", "Aviemore", "Nairn", "Dingwall", "Thurso", "Wick", "Ullapool", "Portree"],
  },
  {
    name: "Borders",
    aliases: ["borders", "scottish borders", "the borders"],
    towns: ["Galashiels", "Hawick", "Kelso", "Peebles", "Selkirk", "Jedburgh", "Melrose", "Eyemouth"],
  },
  {
    name: "Dumfries and Galloway",
    aliases: ["dumfries and galloway", "dumfries & galloway", "dumfries", "galloway"],
    towns: ["Dumfries", "Stranraer", "Annan", "Castle Douglas", "Newton Stewart", "Lockerbie", "Dalbeattie"],
  },
  {
    name: "Moray",
    aliases: ["moray", "morayshire"],
    towns: ["Elgin", "Forres", "Lossiemouth", "Buckie", "Keith", "Fochabers"],
  },
  {
    name: "Clackmannanshire",
    aliases: ["clackmannanshire", "clacks"],
    towns: ["Alloa", "Tillicoultry", "Dollar", "Alva", "Tullibody"],
  },
];

const CITIES: PlaceEntry[] = [
  { name: "Glasgow", aliases: ["glasgow", "glasgow city"], towns: ["Glasgow", "Paisley", "Clydebank", "Rutherglen", "Bearsden", "Bishopbriggs", "Newton Mearns"] },
  { name: "Edinburgh", aliases: ["edinburgh", "edinburgh city"], towns: ["Edinburgh", "Musselburgh", "Dalkeith", "Penicuik", "Livingston", "Queensferry"] },
  { name: "Aberdeen", aliases: ["aberdeen", "aberdeen city"], towns: ["Aberdeen", "Westhill", "Portlethen", "Stonehaven", "Inverurie", "Ellon"] },
  { name: "Dundee", aliases: ["dundee", "dundee city"], towns: ["Dundee", "Broughty Ferry", "Monifieth", "Carnoustie", "Newport-on-Tay", "Invergowrie"] },
  { name: "Inverness", aliases: ["inverness"], towns: ["Inverness", "Nairn", "Dingwall", "Aviemore"] },
  { name: "Perth", aliases: ["perth"], towns: ["Perth", "Scone", "Bridge of Earn", "Crieff", "Auchterarder", "Stanley"] },
  { name: "Stirling", aliases: ["stirling"], towns: ["Stirling", "Bridge of Allan", "Dunblane", "Bannockburn", "Callander"] },
  { name: "Paisley", aliases: ["paisley"], towns: ["Paisley", "Renfrew", "Johnstone", "Glasgow"] },
  { name: "Dunfermline", aliases: ["dunfermline"], towns: ["Dunfermline", "Rosyth", "Inverkeithing", "Cowdenbeath", "Dalgety Bay"] },
  { name: "Kilmarnock", aliases: ["kilmarnock"], towns: ["Kilmarnock", "Irvine", "Ayr", "Troon"] },
  { name: "Livingston", aliases: ["livingston"], towns: ["Livingston", "Bathgate", "Broxburn", "Linlithgow"] },
  { name: "Ayr", aliases: ["ayr"], towns: ["Ayr", "Prestwick", "Troon", "Kilmarnock"] },
];

const SCOTLAND_TOWNS = [
  "Glasgow",
  "Edinburgh",
  "Aberdeen",
  "Dundee",
  "Inverness",
  "Perth",
  "Stirling",
  "Paisley",
  "East Kilbride",
  "Livingston",
  "Dunfermline",
  "Hamilton",
  "Cumbernauld",
  "Kirkcaldy",
  "Ayr",
  "Kilmarnock",
  "Crieff",
  "Falkirk",
  "Airdrie",
  "Greenock",
];

/** One Grok call stays in this range so it finishes inside the timeout. */
export const RESEARCH_BATCH_MAX = 12;
const BATCH = 8;

function fold(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchEntry(location: string, entries: PlaceEntry[]): PlaceEntry | null {
  const key = fold(location);
  if (!key) return null;
  for (const entry of entries) {
    if (fold(entry.name) === key) return entry;
    if (entry.aliases.some((alias) => fold(alias) === key)) return entry;
  }
  return null;
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const name of names) {
    const key = fold(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(name);
  }
  return next;
}

function distribute(names: string[], limit: number): SearchArea[] {
  const towns = uniqueNames(names);
  if (towns.length === 0) return [];
  if (towns.length === 1) {
    return [{ name: towns[0]!, quota: Math.min(RESEARCH_BATCH_MAX, Math.max(1, limit)) }];
  }
  const perTown = limit >= 50 ? RESEARCH_BATCH_MAX : BATCH;
  const expectedYield = Math.max(5, Math.round(perTown * 0.7));
  const needed = Math.min(towns.length, Math.max(1, Math.ceil(limit / expectedYield)));
  const pessimistic = Math.min(towns.length, Math.ceil(limit / 3));
  const extra = Math.max(needed, pessimistic);
  const quota = Math.min(RESEARCH_BATCH_MAX, Math.max(6, Math.min(perTown, Math.max(limit, 6))));
  return towns.slice(0, extra).map((name) => ({ name, quota }));
}

export function detectPlace(location: string): { kind: PlaceKind; label: string; towns: string[] } {
  const key = fold(location);
  if (key === "scotland" || key === "all scotland" || key === "nationwide") {
    return { kind: "nation", label: "Scotland", towns: [...SCOTLAND_TOWNS] };
  }
  const region = matchEntry(location, REGIONS);
  if (region) return { kind: "region", label: region.name, towns: region.towns };
  const city = matchEntry(location, CITIES);
  if (city) return { kind: "city", label: city.name, towns: city.towns };
  const trimmed = location.trim() || "Scotland";
  const home = REGIONS.find((entry) => entry.towns.some((town) => fold(town) === key));
  return {
    kind: "town",
    label: trimmed,
    towns: home ? uniqueNames([trimmed, ...home.towns]) : [trimmed],
  };
}

/**
 * Turn a typed location + result cap into the town batches Grok should search.
 * Small town/city jobs stay a single request. Regions, Scotland, and large
 * caps fan out across constituent towns. The runner stops once `limit` unique
 * genuine businesses are in hand, so extra areas are fallback coverage.
 */
export function planSearch(location: string, limit: number): ResearchPlan {
  const cap = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.round(limit))) : 8;
  const place = detectPlace(location);
  const fanOut = place.kind === "region" || place.kind === "nation" || cap > RESEARCH_BATCH_MAX;
  const towns = fanOut ? (place.towns.length > 0 ? place.towns : [place.label]) : [place.label];
  const areas = distribute(towns, cap);
  return { kind: place.kind, label: place.label, areas };
}

export function locationKindFor(location: string): PlaceKind {
  return detectPlace(location).kind;
}
