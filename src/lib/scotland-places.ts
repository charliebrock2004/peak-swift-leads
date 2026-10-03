import { DISCOVERY_SAFETY } from "./discovery-limits.ts";
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
  /** Search radius for this area; omitted = the run's radius. */
  radiusMiles?: number;
  /** Companies House towns for this area; omitted = a ring around it. */
  chTowns?: string[];
  /** Earlier searches of this area for this trade: rotates the search words. */
  variant?: number;
  /** Searched recently with nothing new — included only because nothing else was left. */
  exhausted?: boolean;
};

export type ResearchPlan = {
  kind: PlaceKind;
  label: string;
  areas: SearchArea[];
  /** Each place the location named, when it named several ("Perthshire, Fife"). */
  places: string[];
  /** Towns left out because their last search found nothing new. */
  restingAreas: string[];
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
      "Errol",
      "Milnathort",
      "Glenfarg",
      "Bankfoot",
      "Luncarty",
      "Inchture",
      "Meigle",
      "Birnam",
      "Kinloch Rannoch",
      "St Fillans",
      "Almondbank",
      "Rattray",
      "Kirkmichael",
      "Longforgan",
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
      "Rosyth",
      "Kinghorn",
      "Aberdour",
      "Kelty",
      "Methil",
      "Buckhaven",
      "Newburgh",
      "Tayport",
      "Crail",
      "Falkland",
      "Ladybank",
      "Auchtermuchty",
      "Kincardine",
      "Markinch",
      "Leslie",
      "Thornton",
      "Lundin Links",
      "Pittenweem",
      "Elie",
      "Newport-on-Tay",
    ],
  },
  {
    name: "Angus",
    aliases: ["angus", "forfarshire"],
    towns: [
      "Forfar",
      "Arbroath",
      "Montrose",
      "Brechin",
      "Kirriemuir",
      "Carnoustie",
      "Monifieth",
      "Friockheim",
      "Letham",
      "Edzell",
      "Newtyle",
      "Auchterhouse",
    ],
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
      "Killin",
      "Denny",
      "Bonnybridge",
      "Kippen",
      "Killearn",
      "Drymen",
      "Strathblane",
      "Cambusbarron",
      "Plean",
      "Cowie",
      "Thornhill",
      "Deanston",
      "Buchlyvie",
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
      "North Berwick",
      "Dunbar",
      "Prestonpans",
      "Loanhead",
      "Whitburn",
      "Armadale",
      "East Calder",
      "Mid Calder",
      "West Calder",
      "Gorebridge",
      "Mayfield",
      "Uphall",
      "Winchburgh",
      "Queensferry",
      "Currie",
      "Balerno",
      "Ratho",
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
      "Carluke",
      "Larkhall",
      "Strathaven",
      "Uddingston",
      "Blantyre",
      "Cambuslang",
      "Kilsyth",
      "Shotts",
      "Biggar",
      "Lesmahagow",
      "Viewpark",
      "Chryston",
    ],
  },
  {
    name: "Ayrshire",
    aliases: ["ayrshire", "north ayrshire", "south ayrshire", "east ayrshire"],
    towns: [
      "Ayr",
      "Kilmarnock",
      "Irvine",
      "Troon",
      "Prestwick",
      "Saltcoats",
      "Largs",
      "Kilwinning",
      "Ardrossan",
      "Girvan",
      "Cumnock",
      "Stevenston",
      "Dalry",
      "Beith",
      "Kilbirnie",
      "Stewarton",
      "Maybole",
      "Galston",
      "Darvel",
      "Dalmellington",
      "West Kilbride",
      "Auchinleck",
    ],
  },
  {
    name: "Aberdeenshire",
    aliases: ["aberdeenshire", "aberdeen shire"],
    towns: [
      "Aberdeen",
      "Peterhead",
      "Fraserburgh",
      "Inverurie",
      "Stonehaven",
      "Ellon",
      "Banchory",
      "Westhill",
      "Portlethen",
      "Huntly",
      "Turriff",
      "Banff",
      "Macduff",
      "Kintore",
      "Oldmeldrum",
      "Laurencekirk",
      "Aboyne",
      "Ballater",
      "Alford",
      "Insch",
      "Mintlaw",
      "Newmachar",
      "Inverbervie",
    ],
  },
  {
    name: "Highlands",
    aliases: ["highlands", "highland", "the highlands", "highland council"],
    towns: [
      "Inverness",
      "Fort William",
      "Aviemore",
      "Nairn",
      "Dingwall",
      "Thurso",
      "Wick",
      "Ullapool",
      "Portree",
      "Alness",
      "Invergordon",
      "Tain",
      "Grantown-on-Spey",
      "Kingussie",
      "Beauly",
      "Muir of Ord",
      "Golspie",
      "Dornoch",
      "Fort Augustus",
      "Kyle of Lochalsh",
    ],
  },
  {
    name: "Borders",
    aliases: ["borders", "scottish borders", "the borders"],
    towns: [
      "Galashiels",
      "Hawick",
      "Kelso",
      "Peebles",
      "Selkirk",
      "Jedburgh",
      "Melrose",
      "Eyemouth",
      "Duns",
      "Coldstream",
      "Innerleithen",
      "Lauder",
      "Earlston",
      "Newtown St Boswells",
    ],
  },
  {
    name: "Dumfries and Galloway",
    aliases: ["dumfries and galloway", "dumfries & galloway", "dumfries", "galloway"],
    towns: [
      "Dumfries",
      "Stranraer",
      "Annan",
      "Castle Douglas",
      "Newton Stewart",
      "Lockerbie",
      "Dalbeattie",
      "Kirkcudbright",
      "Moffat",
      "Gretna",
      "Langholm",
      "Sanquhar",
      "Thornhill",
      "Gatehouse of Fleet",
      "Wigtown",
    ],
  },
  {
    name: "Moray",
    aliases: ["moray", "morayshire"],
    towns: [
      "Elgin",
      "Forres",
      "Lossiemouth",
      "Buckie",
      "Keith",
      "Fochabers",
      "Rothes",
      "Aberlour",
      "Dufftown",
      "Burghead",
      "Lhanbryde",
    ],
  },
  {
    name: "Falkirk",
    aliases: ["falkirk", "falkirk area", "falkirk council"],
    towns: ["Falkirk", "Grangemouth", "Larbert", "Stenhousemuir", "Bo'ness", "Polmont", "Denny", "Bonnybridge", "Camelon", "Brightons", "Laurieston", "Slamannan"],
  },
  {
    name: "Renfrewshire and Inverclyde",
    aliases: ["renfrewshire", "east renfrewshire", "inverclyde", "renfrewshire and inverclyde"],
    towns: ["Paisley", "Renfrew", "Johnstone", "Erskine", "Barrhead", "Newton Mearns", "Giffnock", "Clarkston", "Greenock", "Port Glasgow", "Gourock", "Bridge of Weir", "Kilmacolm", "Linwood", "Bishopton", "Lochwinnoch"],
  },
  {
    name: "Dunbartonshire",
    aliases: ["dunbartonshire", "east dunbartonshire", "west dunbartonshire"],
    towns: ["Dumbarton", "Clydebank", "Bearsden", "Milngavie", "Kirkintilloch", "Bishopbriggs", "Alexandria", "Balloch", "Helensburgh", "Lennoxtown", "Twechar"],
  },
  {
    name: "Argyll and Bute",
    aliases: ["argyll", "argyll and bute", "argyll & bute", "bute"],
    towns: ["Oban", "Dunoon", "Campbeltown", "Lochgilphead", "Inveraray", "Rothesay", "Tarbert", "Tobermory", "Cardross"],
  },
  {
    name: "Clackmannanshire",
    aliases: ["clackmannanshire", "clacks"],
    towns: [
      "Alloa",
      "Tillicoultry",
      "Dollar",
      "Alva",
      "Tullibody",
      "Clackmannan",
      "Menstrie",
      "Sauchie",
    ],
  },
];

const CITIES: PlaceEntry[] = [
  // A city is searched district by district: one 25-mile circle round its
  // centre returns the same well-mapped firms every time, while the districts
  // and the towns around it each have their own.
  {
    name: "Glasgow",
    aliases: ["glasgow", "glasgow city", "greater glasgow"],
    towns: [
      "Glasgow", "Partick, Glasgow", "Shawlands, Glasgow", "Dennistoun, Glasgow", "Govan, Glasgow", "Maryhill, Glasgow",
      "Pollokshields, Glasgow", "Easterhouse, Glasgow", "Springburn, Glasgow", "Cathcart, Glasgow", "Knightswood, Glasgow",
      "Baillieston, Glasgow", "Paisley", "Clydebank", "Rutherglen", "Bearsden", "Bishopbriggs", "Newton Mearns",
      "Milngavie", "Cambuslang", "Giffnock", "Kirkintilloch", "Renfrew", "Uddingston", "Barrhead",
    ],
  },
  {
    name: "Edinburgh",
    aliases: ["edinburgh", "edinburgh city"],
    towns: [
      "Edinburgh", "Leith, Edinburgh", "Portobello, Edinburgh", "Morningside, Edinburgh", "Corstorphine, Edinburgh",
      "Gorgie, Edinburgh", "Stockbridge, Edinburgh", "Newington, Edinburgh", "Liberton, Edinburgh", "Gilmerton, Edinburgh",
      "Granton, Edinburgh", "Musselburgh", "Dalkeith", "Penicuik", "Livingston", "Queensferry", "Loanhead", "Bonnyrigg",
      "Currie", "Balerno", "Ratho", "Tranent",
    ],
  },
  {
    name: "Aberdeen",
    aliases: ["aberdeen", "aberdeen city"],
    towns: [
      "Aberdeen", "Bridge of Don, Aberdeen", "Dyce, Aberdeen", "Cults, Aberdeen", "Torry, Aberdeen", "Kincorth, Aberdeen",
      "Bucksburn, Aberdeen", "Peterculter, Aberdeen", "Westhill", "Portlethen", "Stonehaven", "Inverurie", "Ellon",
      "Kintore", "Newmachar", "Banchory",
    ],
  },
  {
    name: "Dundee",
    aliases: ["dundee", "dundee city"],
    towns: [
      "Dundee", "Broughty Ferry, Dundee", "Lochee, Dundee", "Downfield, Dundee", "Stobswell, Dundee", "Douglas, Dundee",
      "Monifieth", "Carnoustie", "Newport-on-Tay", "Tayport", "Invergowrie", "Longforgan", "Birkhill", "Muirhead", "Wormit",
    ],
  },
  { name: "Inverness", aliases: ["inverness"], towns: ["Inverness", "Nairn", "Dingwall", "Aviemore", "Beauly", "Muir of Ord", "Culloden", "Ardersier"] },
  // Ordered by distance from the city, because the search fans out in order
  // and the nearest towns are where a Perth business is most likely to be.
  // Six towns was too few: a joinery run never reached Methven, Kinross,
  // Errol, Coupar Angus, Blairgowrie or Dunkeld, all of which are an ordinary
  // working radius from Perth.
  {
    name: "Perth",
    aliases: ["perth"],
    towns: [
      "Perth", "Scone", "Bridge of Earn", "Methven", "Errol", "Stanley",
      "Abernethy", "Dunning", "Kinross", "Coupar Angus", "Auchterarder",
      "Crieff", "Blairgowrie", "Dunkeld", "Luncarty", "Bankfoot", "Almondbank",
      "Glenfarg", "Inchture", "Milnathort",
    ],
  },
  { name: "Stirling", aliases: ["stirling"], towns: ["Stirling", "Bridge of Allan", "Dunblane", "Bannockburn", "Callander", "Cambusbarron", "Fallin", "Plean", "Doune", "Alloa", "Denny"] },
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

/**
 * Rows one area is asked for.
 *
 * This used to be 12 and used to be a cap on *results*: every town kept its
 * nearest twelve and the rest were binned before anything looked across towns.
 * It is now purely a fetch budget — how big a page each source is asked for —
 * and every row it returns joins the shared candidate pool. The user's target
 * is applied to that pool, once, at the end.
 */
export const RESEARCH_BATCH_MAX = DISCOVERY_SAFETY.fetchPerArea;

/**
 * Above this target, a single town is spread across its neighbours.
 *
 * A target-shaped decision, so it gets its own small constant rather than
 * borrowing the fetch budget: confusing the two is exactly how the old cap
 * came to throttle results.
 */
const FAN_OUT_ABOVE = 12;

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

/**
 * The radius one area of a wider plan is searched with.
 *
 * Searching every town of a region with the user's 25-mile radius meant every
 * search covered most of the region: Crieff, Comrie, Auchterarder and Perth
 * all returned the same well-mapped firms, and a run reported dozens of
 * "duplicates across areas" while finding nothing new. A town of a plan is
 * searched for what is in and around it; a city district for its streets. The
 * user's own radius is kept when one place is searched on its own.
 */
export const AREA_RADIUS_MILES = { town: 7, district: 3 } as const;

/** "Leith, Edinburgh" is a district of a city, searched at street scale. */
export function isDistrict(name: string): boolean {
  return name.includes(",");
}

/** The name Companies House is asked about for an area ("Leith, Edinburgh" → "Leith"). */
export function chTownOf(name: string): string {
  return name.split(",")[0]!.trim();
}

/** The key coverage memory files an area under. */
export function areaKey(name: string): string {
  return fold(name);
}

/** What coverage memory knows about one area for one trade. */
export type AreaCoverage = {
  searches: number;
  lastSearchedAt: string;
  /** Searching it again before this date would return the same businesses. */
  exhaustedUntil: string;
};

export type PlanOptions = {
  /** The radius asked for: used as-is for a single place, narrowed per area for a wider plan. */
  radiusMiles?: number;
  /** Coverage of each area for this trade, keyed by `areaKey`. */
  coverage?: ReadonlyMap<string, AreaCoverage>;
  /** Areas already searched for this trade in this run (`areaKey`). Never planned twice. */
  skip?: ReadonlySet<string>;
  now?: Date;
  /** Search each area at area scale even when only one is chosen (widening). */
  wide?: boolean;
};

/**
 * Order candidate towns so each run reaches somewhere new.
 *
 * Never-searched towns first, in the table's order (nearest the centre of the
 * place first); then towns searched before, least recently first; towns whose
 * last search found nothing new are left out until their rest period ends —
 * unless nothing else is left, when they come last and the plan says so.
 */
export function rotateAreas(
  towns: readonly string[],
  options: Pick<PlanOptions, "coverage" | "skip" | "now"> = {},
): { ordered: string[]; exhausted: string[] } {
  const now = (options.now ?? new Date()).getTime();
  const fresh: string[] = [];
  const revisit: { name: string; at: number }[] = [];
  const exhausted: string[] = [];
  for (const name of uniqueNames([...towns])) {
    const key = areaKey(name);
    if (options.skip?.has(key)) continue;
    const seen = options.coverage?.get(key);
    if (!seen || seen.searches <= 0) {
      fresh.push(name);
      continue;
    }
    const until = Date.parse(seen.exhaustedUntil);
    if (Number.isFinite(until) && until > now) {
      exhausted.push(name);
      continue;
    }
    revisit.push({ name, at: Date.parse(seen.lastSearchedAt) || 0 });
  }
  revisit.sort((a, b) => a.at - b.at);
  return { ordered: [...fresh, ...revisit.map((item) => item.name)], exhausted };
}

/**
 * Spread a town ring into areas to search.
 *
 * Two numbers, and keeping them apart is the point. `quota` is the fetch
 * budget — identical for every area, never derived from the target, because
 * the target is applied once to the pooled results and not per town. The town
 * count still scales with the target, since asking for 8 prospects should not
 * cost a forty-town sweep, but it scales generously: every town feeds one pool
 * and duplicates between them are free.
 */
function distribute(names: string[], limit: number, options: PlanOptions = {}): { areas: SearchArea[]; exhausted: string[] } {
  const quota = DISCOVERY_SAFETY.fetchPerArea;
  const { ordered, exhausted } = rotateAreas(names, options);
  // Nothing new left to try: search the rested-but-exhausted towns rather
  // than nothing, and say so (the plan lists them).
  const pool = ordered.length > 0 ? ordered : exhausted;
  if (pool.length === 0) return { areas: [], exhausted };
  const wanted = Math.max(4, Math.ceil(limit / 2));
  const count = Math.min(pool.length, DISCOVERY_SAFETY.maxAreas, wanted);
  const chosen = pool.slice(0, count);
  const single = chosen.length === 1 && !options.wide;
  const areas = chosen.map((name) => {
    const seen = options.coverage?.get(areaKey(name));
    const radius = single
      ? options.radiusMiles
      : Math.min(options.radiusMiles ?? AREA_RADIUS_MILES.town, isDistrict(name) ? AREA_RADIUS_MILES.district : AREA_RADIUS_MILES.town);
    return {
      name,
      quota,
      ...(radius ? { radiusMiles: radius } : {}),
      // One area, one Companies House town: the region ring is covered by the
      // plan's other areas, not re-fetched by every one of them.
      ...(single ? {} : { chTowns: [chTownOf(name)] }),
      variant: seen?.searches ?? 0,
      ...(exhausted.includes(name) ? { exhausted: true } : {}),
    };
  });
  return { areas, exhausted: ordered.length > 0 ? exhausted : [] };
}

/**
 * England, as an expandable region set rather than a country dump.
 *
 * Same shape as the Scottish tables, so adding a county or a city is a data
 * edit and never a code change. Deliberately high-value areas only: the point
 * is to reach markets worth working, not to enumerate every settlement in
 * England and drown the sheet.
 */
const ENGLAND_REGIONS: PlaceEntry[] = [
  {
    name: "Greater Manchester",
    aliases: ["greater manchester", "manchester area"],
    towns: ["Manchester", "Salford", "Bolton", "Stockport", "Oldham", "Rochdale", "Bury", "Wigan"],
  },
  {
    name: "Merseyside",
    aliases: ["merseyside", "liverpool area"],
    towns: ["Liverpool", "Birkenhead", "St Helens", "Southport", "Wallasey"],
  },
  {
    name: "West Yorkshire",
    aliases: ["west yorkshire", "leeds area"],
    towns: ["Leeds", "Bradford", "Wakefield", "Huddersfield", "Halifax", "Dewsbury"],
  },
  {
    name: "South Yorkshire",
    aliases: ["south yorkshire", "sheffield area"],
    towns: ["Sheffield", "Doncaster", "Rotherham", "Barnsley"],
  },
  {
    name: "Tyne and Wear",
    aliases: ["tyne and wear", "tyne & wear", "newcastle area", "north east"],
    towns: ["Newcastle upon Tyne", "Sunderland", "Gateshead", "South Shields", "Washington"],
  },
  {
    name: "West Midlands",
    aliases: ["west midlands", "birmingham area"],
    towns: ["Birmingham", "Wolverhampton", "Coventry", "Solihull", "Dudley", "Walsall"],
  },
  {
    name: "East Midlands",
    aliases: ["east midlands", "nottingham area"],
    towns: ["Nottingham", "Leicester", "Derby", "Mansfield", "Loughborough"],
  },
  {
    name: "Lancashire",
    aliases: ["lancashire", "lancs"],
    towns: ["Preston", "Blackpool", "Blackburn", "Lancaster", "Burnley", "Chorley"],
  },
  {
    name: "Cumbria",
    aliases: ["cumbria", "lake district"],
    towns: ["Carlisle", "Barrow-in-Furness", "Kendal", "Whitehaven", "Workington"],
  },
  {
    name: "County Durham",
    aliases: ["county durham", "durham"],
    towns: ["Durham", "Darlington", "Hartlepool", "Stockton-on-Tees", "Middlesbrough"],
  },
  {
    name: "Cheshire",
    aliases: ["cheshire"],
    towns: ["Chester", "Warrington", "Crewe", "Macclesfield", "Runcorn"],
  },
  {
    name: "North Yorkshire",
    aliases: ["north yorkshire", "yorkshire"],
    towns: ["York", "Harrogate", "Scarborough", "Northallerton", "Skipton"],
  },
  {
    name: "Northumberland",
    aliases: ["northumberland"],
    towns: ["Hexham", "Morpeth", "Alnwick", "Berwick-upon-Tweed", "Cramlington", "Blyth", "Ashington", "Ponteland", "Prudhoe", "Amble"],
  },
  {
    name: "East Yorkshire",
    aliases: ["east yorkshire", "east riding", "east riding of yorkshire", "hull area"],
    towns: ["Hull", "Beverley", "Bridlington", "Goole", "Driffield", "Hessle", "Cottingham", "Hornsea"],
  },
  {
    name: "Bristol and the South West",
    aliases: ["bristol area", "south west", "avon"],
    towns: ["Bristol", "Bath", "Gloucester", "Cheltenham", "Swindon", "Taunton"],
  },
];

/** English cities that are worth searching on their own. */
const ENGLAND_CITIES: PlaceEntry[] = ENGLAND_REGIONS.map((region) => ({
  name: region.towns[0]!,
  aliases: [fold(region.towns[0]!)],
  towns: region.towns.slice(0, 4),
}));

/** Every English town the app currently knows, for an England-wide run. */
const ENGLAND_TOWNS = uniqueNames(ENGLAND_REGIONS.flatMap((region) => region.towns));

/** UI chips for English regions. Adding one is a data edit, not a code change. */
export const ENGLAND_REGION_SUGGESTIONS = ENGLAND_REGIONS.map((region) => region.name);
export const ENGLAND_CITY_SUGGESTIONS = ENGLAND_CITIES.map((city) => city.name);

/**
 * A handful of English towns for the picker. Not every town England has: the
 * chips are a starting point, and the input accepts anything the user types.
 */
export const ENGLAND_TOWN_SUGGESTIONS = uniqueNames(
  ENGLAND_REGIONS.flatMap((region) => region.towns.slice(1, 3)),
).slice(0, 12);

/**
 * Which nations the app can search.
 *
 * Wales and the rest of the UK are deliberately absent rather than stubbed:
 * an empty region set would return no towns and look like a bug. Add a table
 * above and a line here when the market is worth working.
 */
export const NATIONS = ["Scotland", "England"] as const;
export type Nation = (typeof NATIONS)[number];

/** Every known place, for telling "Perth and Kinross" (one place) from "Perth and Dundee" (two). */
function knownPlace(name: string): boolean {
  const key = fold(name);
  if (!key) return false;
  if (key === "scotland" || key === "england") return true;
  const tables = [...REGIONS, ...CITIES, ...ENGLAND_REGIONS, ...ENGLAND_CITIES];
  return tables.some((entry) => fold(entry.name) === key || entry.aliases.some((alias) => fold(alias) === key) || entry.towns.some((town) => fold(town) === key));
}

/**
 * The places a typed location names.
 *
 * "Perthshire, Fife" is two regions, not one town called "Perthshire, Fife"
 * (which geocodes to nowhere useful, or to one of them). Commas, semicolons,
 * slashes and new lines always separate; "and" / "&" separate only when the
 * whole is not itself a place ("Dumfries and Galloway") and both sides are.
 */
export function splitLocations(location: string): string[] {
  const parts = location
    .split(/[,;/|\n+]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
  const out: string[] = [];
  for (const part of parts) {
    if (knownPlace(part)) {
      out.push(part);
      continue;
    }
    const pieces = part.split(/\s+(?:and|&)\s+/i).map((piece) => piece.trim()).filter(Boolean);
    if (pieces.length > 1 && pieces.every(knownPlace)) out.push(...pieces);
    else out.push(part);
  }
  // A single district ("Leith, Edinburgh") is one place, not two.
  if (out.length === 2 && knownPlace(location.trim())) return [location.trim()];
  return uniqueNames(out);
}

function detectOne(location: string): { kind: PlaceKind; label: string; towns: string[] } {
  const key = fold(location);
  if (key === "scotland" || key === "all scotland" || key === "nationwide") {
    return { kind: "nation", label: "Scotland", towns: [...SCOTLAND_TOWNS] };
  }
  if (key === "england" || key === "all england") {
    return { kind: "nation", label: "England", towns: [...ENGLAND_TOWNS] };
  }
  const region = matchEntry(location, REGIONS) ?? matchEntry(location, ENGLAND_REGIONS);
  if (region) return { kind: "region", label: region.name, towns: region.towns };
  const city = matchEntry(location, CITIES) ?? matchEntry(location, ENGLAND_CITIES);
  if (city) return { kind: "city", label: city.name, towns: city.towns };
  const trimmed = location.trim() || "Scotland";
  const home =
    REGIONS.find((entry) => entry.towns.some((town) => fold(town) === key)) ??
    ENGLAND_REGIONS.find((entry) => entry.towns.some((town) => fold(town) === key));
  return {
    kind: "town",
    label: trimmed,
    towns: home ? uniqueNames([trimmed, ...home.towns]) : [trimmed],
  };
}

/** Interleave lists so a plan over several places reaches each of them early. */
function interleave(lists: string[][]): string[] {
  const out: string[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let i = 0; i < longest; i += 1) for (const list of lists) if (list[i]) out.push(list[i]!);
  return uniqueNames(out);
}

export function detectPlace(location: string): { kind: PlaceKind; label: string; towns: string[]; places: string[] } {
  const places = splitLocations(location);
  if (places.length <= 1) return { ...detectOne(places[0] ?? location), places: places.length ? places : [location.trim()] };
  const each = places.map(detectOne);
  return {
    // Several places are searched like a region: across all their towns.
    kind: each.some((place) => place.kind === "nation") ? "nation" : "region",
    label: each.map((place) => place.label).join(", "),
    towns: interleave(each.map((place) => (place.kind === "town" ? [place.label, ...place.towns.slice(1)] : place.towns))),
    places: each.map((place) => place.label),
  };
}

/**
 * Turn a typed location + target into the town batches to search.
 * Small town jobs stay a single request. Regions, nations, several places and
 * larger targets fan out across constituent towns — chosen by coverage memory
 * so each run reaches towns the last one did not. Every area feeds one
 * candidate pool, so extra areas add coverage rather than competing for slots.
 */
export function planSearch(location: string, limit: number, options: PlanOptions = {}): ResearchPlan {
  const cap = Number.isFinite(limit)
    ? Math.min(DISCOVERY_SAFETY.targetMax, Math.max(1, Math.round(limit)))
    : 8;
  const place = detectPlace(location);
  const fanOut = place.kind === "region" || place.kind === "nation" || place.kind === "city" || cap > FAN_OUT_ABOVE;
  const towns = fanOut ? (place.towns.length > 0 ? place.towns : [place.label]) : [place.label];
  const { areas, exhausted } = distribute(towns, cap, options);
  return { kind: place.kind, label: place.label, areas, places: place.places, restingAreas: exhausted };
}

/** Regions next to each other, for widening a search that has run out of new businesses nearby. */
const NEIGHBOURS: Record<string, string[]> = {
  perthshire: ["Stirlingshire", "Fife", "Angus", "Clackmannanshire", "Dundee"],
  fife: ["Perthshire", "Clackmannanshire", "Lothian", "Dundee"],
  angus: ["Dundee", "Perthshire", "Aberdeenshire"],
  stirlingshire: ["Clackmannanshire", "Falkirk", "Perthshire", "Dunbartonshire", "Lanarkshire"],
  tayside: ["Fife", "Stirlingshire", "Aberdeenshire"],
  lothian: ["Edinburgh", "Fife", "Falkirk", "Borders", "Lanarkshire"],
  lanarkshire: ["Glasgow", "Falkirk", "Ayrshire", "Lothian"],
  ayrshire: ["Renfrewshire and Inverclyde", "Lanarkshire", "Dumfries and Galloway"],
  aberdeenshire: ["Aberdeen", "Moray", "Angus"],
  highlands: ["Moray", "Inverness", "Argyll and Bute"],
  borders: ["Lothian", "Dumfries and Galloway", "Northumberland"],
  "dumfries and galloway": ["Ayrshire", "Borders", "Cumbria"],
  moray: ["Aberdeenshire", "Highlands"],
  clackmannanshire: ["Stirlingshire", "Perthshire", "Fife", "Falkirk"],
  falkirk: ["Stirlingshire", "Lothian", "Lanarkshire", "Clackmannanshire"],
  "renfrewshire and inverclyde": ["Glasgow", "Ayrshire", "Dunbartonshire"],
  dunbartonshire: ["Glasgow", "Stirlingshire", "Argyll and Bute"],
  "argyll and bute": ["Dunbartonshire", "Highlands"],
  glasgow: ["Lanarkshire", "Renfrewshire and Inverclyde", "Dunbartonshire"],
  edinburgh: ["Lothian", "Fife"],
  dundee: ["Angus", "Perthshire", "Fife"],
  aberdeen: ["Aberdeenshire"],
  inverness: ["Highlands", "Moray"],
  perth: ["Perthshire"],
  stirling: ["Stirlingshire", "Clackmannanshire"],
  "greater manchester": ["Lancashire", "Cheshire", "West Yorkshire", "Merseyside"],
  merseyside: ["Cheshire", "Lancashire", "Greater Manchester"],
  "west yorkshire": ["North Yorkshire", "South Yorkshire", "Greater Manchester"],
  "south yorkshire": ["West Yorkshire", "East Midlands"],
  "tyne and wear": ["Northumberland", "County Durham"],
  northumberland: ["Tyne and Wear", "Borders", "Cumbria"],
  cumbria: ["Lancashire", "Northumberland", "Dumfries and Galloway"],
  "county durham": ["Tyne and Wear", "North Yorkshire"],
  "north yorkshire": ["West Yorkshire", "County Durham", "East Yorkshire"],
  "east yorkshire": ["North Yorkshire", "South Yorkshire"],
  lancashire: ["Cumbria", "Greater Manchester", "Merseyside"],
  cheshire: ["Merseyside", "Greater Manchester", "West Midlands"],
  "west midlands": ["East Midlands", "Cheshire"],
  "east midlands": ["West Midlands", "South Yorkshire"],
};

/** The region a place belongs to, by name ("Crieff" → "Perthshire"). */
function homeRegionOf(place: string): string {
  const key = fold(place);
  const region = [...REGIONS, ...ENGLAND_REGIONS].find((entry) => fold(entry.name) === key || entry.aliases.some((alias) => fold(alias) === key) || entry.towns.some((town) => fold(town) === key));
  if (region) return region.name;
  const city = [...CITIES, ...ENGLAND_CITIES].find((entry) => fold(entry.name) === key || entry.aliases.some((alias) => fold(alias) === key));
  return city?.name ?? "";
}

/**
 * Where to look next when the places asked for are out of new businesses.
 *
 * First the rest of each place's own region (a town search only ever covered
 * part of it), then the regions next door, then any areas the workspace
 * profile lists. Never across a border the user did not name or configure:
 * an England run widens in England, a Scotland run in Scotland.
 */
export function widenCandidates(location: string, configuredAreas: readonly string[] = []): string[] {
  const place = detectPlace(location);
  const nation = nationFor(place.places[0] ?? location);
  const configuredNations = new Set(configuredAreas.map((area) => nationFor(area)));
  const allowed = (name: string) => nationFor(name) === nation || configuredNations.has(nationFor(name));
  const homes = uniqueNames(place.places.map(homeRegionOf).filter(Boolean));
  const own = homes.flatMap((home) => detectOne(home).towns);
  const next = uniqueNames(homes.flatMap((home) => NEIGHBOURS[fold(home)] ?? []));
  const neighbours = interleave(next.filter(allowed).map((name) => detectOne(name).towns));
  const configured = interleave(
    configuredAreas
      .flatMap((area) => splitLocations(area))
      .filter(allowed)
      .map((area) => {
        const found = detectOne(area);
        return found.kind === "town" ? [found.label] : found.towns;
      }),
  );
  // What this run already searched is excluded by the caller (`skip`), so the
  // place's own towns stay in: a town search only ever covered part of them.
  return uniqueNames([...own, ...neighbours, ...configured]);
}

/** A plan over `widenCandidates`, skipping everything this run has already searched. */
export function planWiden(location: string, limit: number, configuredAreas: readonly string[], options: PlanOptions = {}): ResearchPlan {
  const towns = widenCandidates(location, configuredAreas);
  const cap = Number.isFinite(limit) ? Math.min(DISCOVERY_SAFETY.targetMax, Math.max(1, Math.round(limit))) : 8;
  const { areas, exhausted } = distribute(towns, Math.max(cap, 8), { ...options, wide: true });
  // Widening never re-runs a town that is resting: that is the "same
  // businesses again" loop this exists to avoid.
  return { kind: "region", label: `around ${detectPlace(location).label}`, areas: areas.filter((area) => !area.exhausted), places: [], restingAreas: exhausted };
}

export function locationKindFor(location: string): PlaceKind {
  return detectPlace(location).kind;
}

/**
 * Which nation a typed location belongs to.
 *
 * Only English data can answer "England"; anything the English tables do not
 * recognise stays Scotland, which is the home market and the safe default.
 * This is how the picker follows a typed location instead of stranding the
 * user on the wrong set of chips.
 */
export function nationFor(location: string): Nation {
  const key = fold(location);
  if (key === "england" || key === "all england") return "England";
  if (matchEntry(location, ENGLAND_REGIONS) || matchEntry(location, ENGLAND_CITIES)) {
    return "England";
  }
  if (ENGLAND_TOWNS.some((town) => fold(town) === key)) return "England";
  return "Scotland";
}

/**
 * Towns to query when looking up companies around a typed location.
 * Small towns pick their nearest neighbours (Crieff → Perth, Auchterarder).
 */
export function chSearchTowns(location: string, max = 3): string[] {
  const place = detectPlace(location);
  if (place.kind === "nation") {
    const anchors =
      place.label === "England"
        ? ["Manchester", "Birmingham", "Leeds", "Liverpool"]
        : ["Glasgow", "Edinburgh", "Perth", "Dundee"];
    return anchors.slice(0, Math.max(1, max));
  }
  if (place.kind === "region") {
    return uniqueNames(place.towns).slice(0, Math.max(1, max));
  }
  const towns = uniqueNames([place.label, ...place.towns]);
  return towns.slice(0, Math.max(1, max));
}
