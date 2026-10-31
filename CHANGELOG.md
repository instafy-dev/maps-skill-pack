# Changelog

All notable changes to this pack. Versions follow [semantic versioning](https://semver.org/); the release tag is
`v<version>` and `skills/interactive-map/.instafy-pack.json` carries the same version.

## 0.1.21 (2026-10-31)

Fixes from a "Plan 3 days in Seville for a first visit: where to stay, what to see each day, on a map" run whose map
had one sight in three days, and whose reply said the run had ended with six minutes left.

- **`uw plan` and `uw validate` name the uw commands still running on the site.** The run looked up four sights in one
  command. Its command tool stopped waiting after 30 s and answered with a session and no exit code; the turn printed
  only the command's output, which was empty, so it planned the days and replied while the lookups ran on. A network
  command run on a site's folder now leaves a mark in the site's state folder while it runs (`running/<pid>.json`) and
  removes it when it ends. `uw plan` names the ones still running ("Still running on this site: uw add-point … (35 s
  so far). What it finds is not in this plan yet: wait until it has finished …"), in its JSON too (`still_running`,
  `next`), and `uw validate` fails while one runs, as what it finds is not on the map yet. A mark whose process is
  gone (killed with its turn) or whose time is up does not count. The steps `uw handoff --apply` runs as uw commands
  of their own share its run, so they never name it or each other.
- **A place the search found is not "Not found yet".** The search had each of the run's sights as its first hit in
  range, and `add-point --strict-name` refused three of them as not matching their own names, so the map listed them
  as not found: "Real Alcázar de Sevilla" (the search also found streets in Alcázar de San Juan, Ciudad Real, 330 km
  away, whose town made "Real" and "Alcázar" read as words of the area), "Plaza de España, Seville" ("plaza" is a
  generic word and "España" the country) and "Triana, Seville" (the district the other hits lie in). The words of the
  area now come from the hits in range, and a hit whose own name is the query's name (accents, case and punctuation
  aside; the part before a comma) is a match.
- **The guide no longer says to reply "with time to spare".** SKILL.md said "card + map + verdict early, reply with
  time to spare", and the run's reply blamed the run's end with six minutes left. The turn clock's rule stays: under
  about 3 minutes left, start nothing slow and reply.
- **No suggestion chips.** SKILL.md ended a reply with a ```suggestions block, and the trip guide with "2-3 one-tap
  follow-ups"; Instafy shows no chips, so such a block would show as text. Both are gone, and so are the trip guide's
  other one-tap follow-ups.
- **Days in one place have no "Stops" group.** The places list had a "Stops 1" group with the city itself. `uw plan`
  with one stop sets that layer's `"list": false` (the Plan tab names the stop); a trip of several stops lists them
  again.
- **A place of worship has the neutral sign.** A cathedral showed a shrine gate (⛩️), the sign of every
  `place_of_worship`; it is 🛐 now, any faith's. A temple or shrine the places search found by its religion keeps its
  own.
- **Tests:** a fixture run of the Seville request with the search's own answers for the run's queries, one lookup per
  command and one of them slow: `uw plan` and `uw validate` name the slow one while it runs, and "Not found yet" does
  not list it; once it has finished, each full day has 2 or 3 sights cited from their own pages, "Not found yet" lists
  only the place the search did not find, the stop is not a group in the places list, and `uw validate --signal`
  passes. Unit tests for the marks (a process that is gone, a mark out of time, the same run), the name rule, a far-off
  hit's town, the neutral sign and the guides' words. Each fails without its change.

## 0.1.20 (2026-10-31)

Fixes to 0.1.19, found in its review.

- **Two towns a short ride apart are a trip again.** 0.1.19's `uw plan` refused any two stays closer than about 15 km
  as "places in one city", with no way past it: "2 nights in Positano, then 2 in Amalfi" (10 km), Nice and Monaco
  (13 km) or a night at the airport before the city could not be planned, and with both stops in the map's "expect"
  `uw validate` asked for the plan that `uw plan` refused, so the map could never pass. The refusal now holds only for
  places in one city: a sight, a square, a neighbourhood or a pin with no kind, and two stations of one city. Two
  places of their own (a city, town, village or island, a station or an airport, by the stop's `kind`) are planned as
  before, and so is a stop beside one of them when the map's "expect" names both (a night at a hut above the town:
  `uw validate` asks for each in the plan). Two pins that are neither stay one city, whatever "expect" lists.
- **The refusal gives the nights of the places it refuses.** On a trip with other stops it said to plan one stop with
  the whole trip's nights (`--nights 5` for two Seville pins and Córdoba); it now gives those places' own nights
  (`--nights 3`), "with the trip's other stops as they are".
- **`uw validate` counts the stops on the map.** "asked for but not on the map: … (N of M stops on the map)" counted
  only the stops that were also in the plan, so a stop on the map but in no day made the number too low; it counts
  every stop on the map.
- **`uw new --json` keeps its next steps.** The JSON result had only the site's facts, so a turn that made a trip's
  site with `--json` never saw "Then: a trip (…): follow reference/itinerary.md ("One base" for days in one place)".
  The result now carries the same lines as `next`.
- **Corrected note (0.1.19, "dark from its first frame"):** the host's theme before the first frame comes from the
  last layout at the same address in this tab, which is a reload of the same frame (Studio's Reload button). Studio
  opens a site at a new address each time, so a card press or a reload of Studio still waits for the host's layout
  message. Only `engine/host-theme.js`'s comment changes.
- **Tests:** unit and command tests for two towns (with the stops in "expect" and with no "expect"), a city and a
  city-state, a station and a village, a night at the airport, two stations of one city, a hut above a village (a trip
  only when "expect" names both), sights listed in "expect" with a night each (still one city), the refusal's nights
  on a trip with another city, the stop count, and `uw new --json`'s next steps. Each fails without its change.

## 0.1.19 (2026-10-31)

Fixes from a "Plan 3 days in Seville for a first visit: where to stay, what to see each day, on a map" run, whose plan
made each day a place of its own ("Travel day … about 10 min by train" between neighbourhoods 2 km apart), had four
dates for three days and a "Days" group in the list; and from reloading a map in a dark Studio.

- **`--expect` takes only a trip's stops with their nights.** The run listed its own items there ("Where to stay",
  "Day 1: historic center", …), renamed its pins to match them ("Day 1 · Alcazar and cathedral"), and those pins
  became the trip's stops. `uw new --expect` (and `uw validate --expect`) now refuse anything but stops with nights,
  before anything is made: "Name only the trip's stops with their nights ("Lisbon:3"). Days and stays come from uw
  plan and uw stay." `uw validate` reads only the stops a map lists (other items an older map listed are not read),
  and SKILL.md rule 8 says only that.
- **`uw plan` refuses stays in one city.** Two stays in a row (nights at both) closer than about 15 km
  (`trip_out_km` in `scripts/plan-checks.json`, the distance that already makes a place a trip out of town) are
  refused: "These are places in one city (… are 1.2 km apart). Plan one stop (--ids <city> --nights 3: …); its sights
  are grouped into days by area." A stop passed through (0 nights: an airport, a station out of town) and a loop's
  return to its first stop are not stays. A wrong plan then never reaches the map.
- **Days in one place have no departure date.** "3 days" was 3 nights plus a fourth date ("Leave <city>.") with
  nothing on it. A plan with one stop now has a dated day per night and no departure day; the stay line for the reply
  still runs to the day the traveller leaves ("Seville 3 (3 nights, Sun 1 Nov – Wed 4 Nov)"), the dates a booking
  needs. A trip of several stops keeps its departure day.
- **A reloaded map is dark from its first frame.** A dark map faded in from the style's light land on every load:
  MapLibre fades a paint change over 300 ms, the first look too, and on a reload the cached light tiles showed through
  it. In a dark host on a light device, the light page also showed until the engine's modules ran. The map's look now
  goes in without a fade until the map is drawn (later changes, the hour, still fade), and the host's theme from its
  last layout in this tab goes on the page before it draws (`engine/host-theme.js`, loaded first by `index.html`). A
  site made before 0.1.19 keeps its own `index.html`, so `uw upgrade` brings it the first half only. The `ready` in the
  layout-ack (0.1.17) already keeps a host's line until the map is drawn.
- **Tests:** a fixture run of the Seville request (place search, lodging search and walking router mocked): the run's
  own `--expect` list is refused, its pins as stops are refused, and the guide's flow gives one stop, three dated days
  of 2-3 sights each cited from its own page, three hotels from `uw stay`, no travel day and no "Days" group, and
  `uw validate --signal` passes. Unit tests for the stops-only `--expect`, the one-city refusal (a 0-night stop and a
  loop pass) and the plan's dates. A host-frame browser test reloads a map three times in a dark host on a light
  device and finds no light frame; it fails with either half of the change taken out. A synthetic trip in the
  itinerary tests passes through its stop 10 km from the first instead of staying there.

## 0.1.18 (2026-10-31)

Fixes to 0.1.17, found in its review.

- **The plan waits for each lookup to finish.** A command tool answers a lookup that outlasts its wait with a session
  and no exit code, and the trip guide ran `uw plan` once each lookup had "answered". It now runs `uw plan` once each
  has finished (an exit code), and waits on one still running instead of starting it again. The team handoff's report
  says the same where the model acts on it: the sights the place lookup could not place come with "run each in a
  command of its own, and once each has finished … uw plan … --force" (it said "run these", and pasted into one
  command, one slow lookup held back the rest and the plan).
- **`uw wait` ends within a command's wait.** A command tool waits at most 30 s for a command, then answers with
  the output so far. `uw wait` waited 50 s, so a turn waiting on a long job (a team's `uw handoff … --apply --detach`)
  got that output with no word that the job ran on. It now waits 25 s, then says "still running … run `uw wait <id>`
  again" itself.
- **A map that cannot draw keeps its card's picture.** Its error screen set the page's ready mark, so the card's
  picture became the error message and a page check counted the page as drawn. It now only tells its host `ready`;
  the mark stays "false", as `__uwReady` does.
- **Every map that cannot draw says why, at once.** A style that does not load (one that does not parse), settings
  that are not an object and a start that breaks on its settings (a layer list that is not a list) left the map empty
  with no reason, and, with 0.1.17's `ready` in the layout-ack, held a host's "Opening <title>…" for 15 s. They now
  show why and say `ready` at once. One message shows, however many errors the style reports.
- **Tests:** a host-frame browser test for four maps that cannot draw (each says `ready` once, keeps its ready mark
  "false" and shows one message), one for `uw wait` (it ends within 30 s on a job still running, and says so), and
  the trip guide's test now also reads the team report's line; each fails on 0.1.17. A host-frame test for a layout
  whose chrome covers the frame's bottom while the tiles load (the places fit above it at once) covers 0.1.17's refit
  on a host layout, which no test did: it fails without that refit. Two `uw handoff --apply` suites no longer reach
  the live tile server: the rail track's fallback reads their mock's tiles.

## 0.1.17 (2026-10-31)

Fixes from a "Plan 3 days in Seville for a first visit … what to see each day, on a map" run, whose map had one sight
in three days and no Plan tab, and from reloading that map dark in Studio.

- **One lookup per command, then the plan.** The run put three sight lookups and `uw plan` in one command, twice. A
  slow lookup outlasted the command, so the sights after it and the plan never ran, and the turn replied with minutes
  left. Phase B of the trip guide now runs each sight in a command of its own, one `uw add-point` per command, and
  `uw plan` once each has answered, with the sights that landed (one not found stays out, in the reply's unverified
  line). A team's unplaced sights run the same way.
- **The host's dark theme counts at once.** In Studio on a light device, the frame learns Studio's dark theme from
  Studio's message, which can come after the map's style is in. The map then stayed light under the dark page until
  every tile was in (2 to 3 s on a reload). The basemap now follows a theme change from the moment its style is in.
- **A frame resized while the tiles load keeps its places in view.** The first view was fitted again to a new frame
  size only once every tile was in, so a frame that got its height while the tiles loaded showed its places zoomed
  out, then zoomed to them. It now fits them again at once, from the map's first frame on, until someone moves it.
- **Studio says it is opening the map until the map is drawn.** After a press on a map's card, Studio said "Opening
  <title>…" only until the frame loaded, and the map then drew itself for 2 to 5 s in a dark, empty pane. Studio keeps
  its line for a page that lists "ready" in its layout-ack, until that page says `ready`. The map now lists it and
  says `ready` once its first view is drawn, or at once when it shows why it can't draw.
- **Tests:** three browser tests in a host's frame (its theme after the style is in, a resize while the tiles load,
  `ready`), and one for the trip guide's one lookup per command.

## 0.1.16 (2026-10-30)

Fixes to 0.1.15, found in its review.

- **Planning the days never narrows the first view.** `uw plan` framed only the trip's own layers, so a hand-picked
  place it was not given (a day trip, a marked airport) fell out of the first view, and `uw validate` then called it a
  wrong match. The trip's frame now also keeps every layer `uw fit` frames.
- **The next-sight rule is for sights.** A place to stay (`--kind hotel`, a stays layer) that cannot be pinned no
  longer ends with "add the next sight from the city page"; `uw handoff` lists its researched hotels itself.
- **A site's own road-number colour stays.** At night a sign whose number colour an override set keeps the sprite's
  image and that colour, as the day/night look never overwrites an override.
- **Tests:** the refusal test reads Taiwan's lodging registers from the fixtures' cache instead of downloading them,
  and the first-view browser test waits for a drag's inertia to end before it resizes the frame.

## 0.1.15 (2026-10-30)

Fixes from a "3 days in Porto for a first visit … what to see each day, on a map" run, whose map had one sight in
three days, and from looking at that map dark and on a phone.

- **A sight that cannot be pinned is listed, and the next one is added.** The run tried one sight four times with
  `--strict-name`, and the refusal only invited another try. Every `--strict-name` refusal now ends with the trip
  guide's own rule: "Retried once? List it as unverified and add the next sight from the city page." (also as `next`
  in `--json`).
- **Sights come from this turn.** The run replied after three minutes, with two days still empty, saying a browser
  would gather more sights; none did. Phase B of the trip guide now says: "Sights come from `uw cite` in this turn,
  never from a browser card."
- **A trip's first view frames its places.** The view stayed on the city centre `uw new` was given, west of the old
  town, so a phone opened with the base and the sight at its right edge. `uw plan` now frames the trip (its stops,
  stays, legs and day places, as `uw fit --layers`), and `uw fit` counts a trip's stations and places to stay among
  what it frames. The engine also fits the first view again when the frame changes size under it (a wide frame
  turned phone-sized, the host's bars over it), until someone moves the map.
- **A dark page draws a dark map from its first frame.** The day/night look waited for every tile, so a dark page
  showed the style's light land until they came (a white map for seconds on a reload). The look is now applied as
  soon as the style is in, before its first frame.
- **Road shields read on a dark map.** Kept as the sprite draws them, they were glaring light boxes on the dark map.
  At night a sign is drawn as its night version: the sprite's own image with light and dark swapped (a dark box with
  a light edge, a coloured shield a lighter one) and a light number. By day it is the sprite as it is.
- **The phone sheet follows a drag from its handle.** A mouse (and a browser that sends mouse events for a phone) is
  not held by the handle it pressed, so the drag's moves went to the map and the sheet never rose. The sheet now
  follows the drag wherever the pointer goes.

## 0.1.14 (2026-10-30)

Fixes to 0.1.13, found in its review.

- **The last check refreshes the card's picture.** Step 9 ran `instafy preview check --phone`, which loads the phone
  size only, and the check pictures only its desktop load, so the card kept the empty map step 3 posted it with and
  the bare "Map" line. Step 9 now runs the check at both sizes (`instafy preview check --port <port>`): its desktop
  load refreshes the card's picture and its facts line. A later change to a trip ends with step 9 too.
- **After a plan or a team job, the next step is step 9.** `uw plan` and `uw handoff --apply` still said "then the
  preview card", a step the turn no longer has (the card is out since `uw new`); they now name step 9.
- **A trip that starts at a stop with no night has every night it was given.** A first stop passed through (an airport,
  `--nights 0,…`) got a day of its own, "Arrive in …; night 1 of 0.", so the stay after it started a day late, and
  since 0.1.13 counts the arrival day `uw validate` asked for places on a day no place can go on. The trip now starts
  with the travel day that leaves that stop, on the arrival date.
- **A day with nothing to see says when re-planning is enough.** A plan made before 0.1.13 has its arrival day bare
  and fails `uw validate` now. The error says `uw plan … --force` spreads the places already pinned over every day,
  the arrival day too, so a stop with as many places as days needs no new ones.

## 0.1.13 (2026-10-29)

Fixes from a "Plan 3 days in Lisbon for a first visit: where to stay, what to see each day, on a map" run, where the
turn ended with no card and no places to stay, and its three sights cited one city page.

- **The card comes first.** The card was posted at the end (step 9), and the turn ended while `uw stay` still ran, so
  there was no card; the reply pointed at the map anyway. `SKILL.md` step 3 now runs the one `instafy preview open
  --title "<title>" --serve-cmd "uw host . --port {port}" --start --json` right after `uw new` writes the site, before
  any lookup, and `uw new` names that command as the next step. A slow lookup can cost the map content, never its card.
  Step 9 is now `uw reload <site>` (open viewers update) and `instafy preview check` (refreshes the card's picture);
  the trip guide and the team handoff do the same. No reply line points at a card (already so since 0.1.10).
- **`uw stay` answers within its own time.** It waited on a busy Overpass for up to two minutes (its 120 s limit),
  three runs side by side, and the turn ended with all three still running. Its limit is now 30 s: the lodging
  search gets most of it and the rest is kept for the walks, the English names and the write, so a busy Overpass
  gives the place search's shorter list (marked partial), and a lodging register that cannot answer in time (a first
  download on a slow link) gives way to OpenStreetMap. Hotels and hostels alike. When nothing answers in time it says
  so plainly: "No places to stay found near <place>: …", the line for the reply, and the command to try again later
  (exit 4). The place search's list also keeps hotels mapped as buildings: it dropped every place that was not a
  single point, so a fallback near Baixa had hostels and no hotel.
- **Every day of the stay gets a place.** With three sights for three days the arrival day had none and the next two
  had one and two. The trip's arrival day is one of its days now: it takes a place as soon as there are more places
  than full days (`plan-checks.json` `first_day_over` 1), and `uw validate` fails while it has nothing to see in a plan
  made with `--sights`, as for the other days.
- **A place cites its own page.** The trip guide says a city's page only tells which places are worth it: each place's
  source is its own page, the one `uw cite` reads. `uw validate` warns when places cite one page (anchors on that page
  included) and says how to give each its own.
- **Road numbers draw on a dark map.** The night look turned a road shield's number light and dimmed its light box,
  so shields read as blank grey boxes. A sign (text drawn centred on its own icon) keeps its sprite's colours at every
  hour.
- **The resting phone sheet clears what sits below it.** Its tab bar ended at the frame's bottom edge, against the
  host's floating chips. It now ends 12 px above that edge, over the sheet's own colour, with nothing of the list
  showing in the gap.

## 0.1.12 (2026-10-29)

Fixes to 0.1.11, found in its review.

- **A place next to a station is taken only under a name it has.** 0.1.11 took the nearest square, park or sight within
  600 m of a station whatever its name, and showed it under the name asked for. The search's filtered answer lists
  places that only share a word with the station ("St Pancras Lock" for "St Pancras International") or only the city
  (parks across Paris for "Gare du Nord, Paris"). The place is now taken only when the name asked for is its own name or
  one of its other names in OpenStreetMap (Rossio is the square's `alt_name`: one Overpass lookup); otherwise the station
  stays. When that cannot be checked the station stays too, and the warning names the place and its `--osm` id.
- **`uw stay` never says there is no hotel when one is in range.** The hotel only took the place of a second pick of
  one kind, so with `--max 1`, with picks of different kinds, or with the hotel in the building of the hostel it would
  replace, no hotel was picked and the output said "No hotel within 800 m" while one was 450 m away. The closest hotel
  now takes the place of the last hostel, or of the last pick; "No hotel within …" is said only when none is in range.
- **Plain words for the kinds of places a trip goes to.** 0.1.11 left out every kind not on its list, so "National
  park", "Nature reserve", "City gate", "Town hall", "Water park" and others that 0.1.10 showed had no kind, and neither
  had the lines `uw lines` writes ("subway", "tram", "ferry"). They have their words again ("Metro", "Tram", "Ferry"); a
  kind with no plain word ("board") is still left out.
- **A search box a keyboard focuses is brought into view.** With the phone sheet lowered the box is out of view; a
  keyboard (Tab) could focus it there and it stayed hidden. It now opens the sheet half way. Focusing a box in view
  still never moves the sheet.

## 0.1.11 (2026-10-29)

Small misses from the fourth 29 Oct 2026 drive ("3 days in Lisbon", on a 375×812 phone).

- **A kind with no plain word is left out.** Arco da Rua Augusta's card said "Board": OpenStreetMap has an information
  board by the arch under its name, and a card showed any kind as its tag. A place's kind now shows only as a plain word
  ("Museum", "Square", "Place of worship", "Café") or not at all; a kind written by hand ("B&B", "Day trip") stays as
  written. Every kind the uw commands write has its word.
- **A square named like its station is the square.** "Rossio" went on the map as Rossio railway station, "Station" on
  its card: OpenStreetMap names the square "Praça Dom Pedro IV", so the name search found only the station. A station
  is never the place it is named after unless the query (or `--kind`) asks for transit: `uw add-point` looks for that
  place among squares and places to walk to within 600 m of the station and takes the nearest, shown under the name
  asked for ("Rossio", its own name under it). The station stays an alternative (`--pick N`).
- **`uw stay` keeps a hotel with the hostels, or says it found none.** Baixa's three closest were hostels, and the reply
  guessed "no hotels were confirmed". With hotels asked for (the default `--kinds hotel,hostel` too), a hotel in range
  is always a pick: the closest takes the place of the last of three hostels. None in range is said: "No hotel within
  800 m of <place>", in the line the reply copies too (JSON `no_hotel`).
- **The raised phone sheet shows its list.** Half open, in Studio's 572 px frame, it showed the search box, the
  "Sights" heading and half of the first sight, cut at the edge where Studio's chips and composer start. Half open now
  shows at least 240 px of the list, as far as the frame has room, and the list fades out over its last 16 px just above
  the bottom edge (a host's composer, the phone's home bar) instead of running on under it.
- **Search focus leaves the sheet where it is.** Focusing "Search places" raised the sheet to the top, so the next tap
  opened another place. Typing filters the list in place.
- **"© OpenStreetMap contributors" once.** The Map key's Sources listed the basemap's credit and `uw stay`'s
  "© OpenStreetMap contributors (ODbL)"; credits that say the same thing (links, case and a licence in brackets aside)
  now show once there and in the map's ⓘ.

The drive also saw the map stay dark after Studio switched to light. Not reproduced: Studio sends its new theme and the
map follows at once, the sheet and the basemap, on screen or hidden; a browser test now guards it.

## 0.1.10 (2026-10-29)

Fixes from the fourth 29 Oct 2026 drive, where a comparison page's card showed the Lisbon map and the map's own card
died, and the map turn ended with "Open the map from its preview card" and no card.

- **One command serves the map and shows its card.** Step 9 ran `uw host <site> --port 4173 --detach`, then the
  `instafy preview open` line it printed, and turns skipped the second step. Every site in a space was put on 4173.
  Now step 9 is one `instafy preview open --title "<title>" --serve-cmd "uw host . --port {port}" --start --json`
  from the site's folder: Instafy picks a free port for the map, starts it, posts the card and takes its picture.
  The skill names no port. `uw host … --detach` no longer prints a second way to show the map in Instafy.
- **No sentence points at a card.** "Open it from the card" left the skill's reply (step 9, Phase C) and the trip
  guide's reply: the card speaks for itself, and a turn that posted none never says it did.
- **The card's picture waits for the map.** The engine marks the page `<html data-instafy-ready="false">` while it
  draws and `"true"` once it is idle with its tiles drawn and its description written, with `window.__uwReady`.
  Instafy's preview picture waits for that mark, so a card no longer shows an empty map.

Step 9 needs an Instafy runtime whose `instafy preview open --start` picks the port (`{port}`); the runtime release
that pins this version has it.

## 0.1.9 (2026-10-28)

- **A finished step reads as done.** In the turn's step list a finished `uw new`, `uw host`, `uw geocode` and the
  other setup steps read "Working on the map" beside their check mark, as if still running. Those quiet labels now
  have a past tense, "worked on the map", which the step list shows once the step is done. They still never appear in
  the turn's one-line summary.

## 0.1.8 (2026-10-28)

Fixes from the third 28 Oct 2026 drive ("3 days in Lisbon … what to see each day", on a phone).

- **Every day has something to see.** `uw plan … --sights sights,food,daytrips` ran before any place was pinned,
  `uw validate` only warned that the days were empty, and the reply shipped two full days with nothing on them. A plan
  made with `--sights` now keeps those layers (`"sights"` in the plan), and `uw validate` fails while a full day has
  no sourced place ("2 of 2 full days have nothing to see"), just as it fails for a stop asked for that is not on the
  map. `uw plan` says so when `--sights` names layers with no place yet, instead of "No --sights". The trip guide pins
  2-3 sourced places per day before the plan, and a place the lookup cannot pin goes on its day with its page's link.
  A plan without `--sights` (where to stay, not what to see) keeps the warning.
- **A stay's card in plain words.** "2 min walk (routed, 161 m) to Baixa · hotel in OpenStreetMap, 4★ (OSM tag)" is
  now "2 min walk to Baixa · hotel, 4★" ("about 2 min walk" when the walk is estimated). How each part is known (161 m
  along the streets, routed on OpenStreetMap; kind and stars as mapped) is under the card's collapsed "How we know",
  from a new `how` property any command can write.
- **The Map key's credits are one tap away.** The key ended with "Walking times: OSRM (FOSSGIS) on OpenStreetMap" and
  the other credits; they now sit under a collapsed "Sources", as on a card, and the map's ⓘ still shows them.
- **The sheet's title wraps.** On a phone it was cut after one line ("Where to stay and what to see each …"); it now
  takes two lines before it is cut, as in the side panel.

## 0.1.7 (2026-10-28)

Fixes to 0.1.6.

- **Plain words in what the agent passes on.** `uw stay` told the agent to say its picks came "from public
  registers/OSM", and `uw snapshot` without a browser to say the map "was validated". Both lines are copied into the
  reply, so they now say "from OpenStreetMap and public registers" and that "the map's data was checked, but not how
  it looks".
- **No words in single-quoted `--props` left.** Three examples still put words in single-quoted JSON, which an
  apostrophe breaks as "Alfama's" did: a stop placed by hand (`"station_of":"<City>"`, as in "L'Aquila"), a place
  geocoded by its address (`"source":"<where the address came from>"`) and `uw validate`'s hint for a day with no
  sourced place. They use `--props-file -` with a quoted heredoc, as does "One base"'s area to stay in, whose note
  now goes in that object instead of a double-quoted `--note`.

## 0.1.6 (2026-10-28)

Fixes from the 28 Oct 2026 drive ("3 days in Lisbon … what to see each day").

- **A trip is days too.** `SKILL.md` sent "nights in one or more places" to `reference/itinerary.md`, so "3 days in
  Lisbon" took the steps for choosing a hotel: one neighbourhood as the only "hotel" and the days written into the
  pins' notes, with no plan. A trip is now days or nights somewhere ("what to see each day"), routed before Phase A,
  and `uw new` points a trip to the itinerary. `uw validate` fails while a stop asked for with nights (`--expect
  "Lisbon:3"`) has no plan. "One base" never pins the area as a hotel: with no stay found it pins the area as the
  recommendation, labelled as one.
- **Plain words on the map.** A place card and the Places list said OpenStreetMap's own classes ("Baixa · Suburb",
  "Belém · Administrative") and "Source: OpenStreetMap search (Photon) · osm.org/node/…". Area classes now read
  "Neighbourhood", "District", "Area", "Town" (a bare "yes" or "house" says nothing), and map data reads "Map data ©
  OpenStreetMap"; another source keeps its name without the lookup in brackets. A new map has no "neighbourhood feel
  layer" subtitle.
- **Props without shell quoting.** `uw add-point` and `uw set` take `--props-file <file>`, and `--props-file -` reads
  stdin, so a quoted heredoc carries "Alfama's" or quotes that single-quoted `--props` JSON broke (3 of 18 steps
  failed on it). The skill and the itinerary use it for props with words in them.
- **Replies in plain words.** The reply rules leave out lookup services, commands and exit codes ("Overpass place
  search was unavailable"), say what was busy plainly, and name sources by who publishes the data.

## 0.1.5 (2026-10-28)

Fixes to 0.1.4.

- **Not a hotel named after the place.** `add-point`'s preference for a candidate whose own name is the query's (0.1.4)
  ignored generic words on the candidate's side too, so "Hôtel du Sacré-Cœur" or "Café Sacré-Cœur" counted as
  "every word of the query and no other" and replaced "Basilique du Sacré-Cœur", the landmark the search listed first.
  A generic word still never makes a name match, but a candidate's generic word the query does not have is a word
  more: only the place itself, or a name with every word of the query and none it lacks, replaces the search's pick.
- **Each leg at its place in the order.** A trip that goes the same way twice ("Lisbon → Porto → Lisbon → Porto")
  took the first Lisbon → Porto leg for both travel days since 0.1.4. A travel day now takes the leg at its place in
  the order between its two stops first (also when the list names a stop twice in a row), then any leg between them.
- **Every place that fits no day is named.** `not_on_plan` and "Not on any day" listed only places with a `"stop"`;
  a place without one goes to the nearest stop, and now it is named too when it fits no day there.

## 0.1.4 (2026-10-28)

Fixes from the 27 Oct 2026 live test ("Plan 3 days in Lisbon").

- **Days in one place.** `uw plan` takes one stop: "3 days in Lisbon" is `--ids lisbon --nights 3`, a stay whose days
  are loops from the same base, with no travel day. It refused one stop ("a trip plan needs at least two stops"), so
  the agent named the city twice and got "Lisbon → Lisbon … Travel day". A stop named twice in a row is now one stay
  (its nights add up), and one stop with 0 nights is a single day. `reference/itinerary.md` gains "One base": the
  city as the stop, stays in the area recommended (`uw stay --near <lng,lat> --near-label "<area>" --stop <city>`),
  places by area, the plan. A stay near a district walks "to <district>", not "to the station".
- **A day's places lie together.** `uw plan` groups a stop's places by area: the closest share a day (no day spans two
  areas when another split exists, and places in one area are shared evenly), each day in walking order from the
  base, the area nearest the base first; the trip's first day takes an area too when the full days would hold more
  than 2 places each. Places were spread over the days by
  count, which put Jardim da Estrela on the Alfama day. `uw plan` and `uw validate` warn when a day has a place far
  from its other places or nearer another day's, and name the day it belongs to ("… is 2.2 km from that day's other
  places but 0.1 km from "Basílica da Estrela" on Fri 30 Oct"); a day trip far out of town is judged on its own. The
  thresholds are data: `scripts/plan-checks.json`. Places that fit no day (over `--per-day`) are named in the output
  (`not_on_plan`) instead of being dropped quietly. A travel day takes the leg between its two stops before the leg at
  its place in the order.
- **The place, not a place named after it.** `add-point` takes a candidate whose own name is the query's name (or
  every word of it and no other) over one that only contains it, whatever order the search gave: "Padrão dos
  Descobrimentos" is the monument, not "Miradouro do Padrão dos Descobrimentos". A station or stop is never preferred
  this way unless the query asks for a kind of transit (the zoo, not the metro station named after it; "… Airport"
  still gets the airport).
- **The departure day says what it is.** The day after the last night carries `"depart": true` and "Leave <stop>.";
  nothing is planned on it, its row says "Departure" instead of looking like an empty day, and the page's "Trip · N
  days" does not count it ("3 days in Lisbon" reads "Trip · 3 days").
- **A preview the space can start again.** `uw host --detach` (and `uw serve --detach`) prints the one command that
  starts the same server in the foreground (with the site's absolute path, so it runs from wherever the card was
  opened) and the `instafy preview open … --serve-cmd "…"` line, and `SKILL.md`
  step 9 runs that line, so a stopped or sleeping map comes back from its card on any platform. A server keeps its own
  record while it runs, and one of the same folder that answers on the port is reused, so a server the space started
  again is found by the next `--detach`, `--stop` and `uw reload` instead of a "port in use".
- **No `.uwcache/` in the space's files.** In an Instafy space (`INSTAFY_CACHE_DIR` set) a site's working state (its
  server's record and log, the write lock, the turn clock) and the background jobs a folder starts live in
  `INSTAFY_CACHE_DIR/interactive-map/state/`, and responses only in the space's shared answers; jobs used to write a
  `.uwcache/` at the workspace root. Adapter datasets (`uw adapter`, handlers) use the same shared cache
  (`UW_CACHE`, else `INSTAFY_CACHE_DIR`, else `~/.cache/uw`), so a hosted turn no longer downloads them again. Outside a
  space nothing changes.

## 0.1.3 (2026-10-27)

- **`uw` is a command.** `.instafy-pack.json` declares `"bin": {"uw": "scripts/uw.mjs"}`, so a runtime that knows
  `bin` puts `uw` on PATH in every shell. `SKILL.md`, `reference/recipes.md`, the README and `uw help` say to run
  `uw <command>` and no longer define a `uw()` shell function, which the agent wrote again before every command
  because each command runs in a fresh shell. Where a shell does not find `uw`, `SKILL.md` says to run
  `node <this skill's folder>/scripts/uw.mjs`; `entry` stays, so older runtimes keep their launcher.
- **Activity labels.** The manifest's `activity` table gives each `uw` subcommand a short, fixed label for a chat's
  activity line: "Looking up places" while `add-point` runs, then "looked up 14 places"; `validate` that exits 0 is
  "built the map"; setup steps (`new`, `fit`, `serve` …) are quiet. Labels are plain words only a count fills in,
  checked by `scripts/pack-commands.mjs` (`node scripts/manifest.mjs --check`), never text from a command's output.
- **The page says what it is.** The engine sets `<meta name="description">` from numbers and fixed words only:
  "Trip · 3 days · 14 places", or "Map · 14 places" (context dots are not counted). A link preview, such as
  Instafy's preview card, shows it; the title and place names never go in it. `uw upgrade <site>` brings it to an
  existing site.
- `SKILL.md`: after a later change and `uw reload`, run step 9's `instafy preview check` (it refreshes the preview
  card's picture where Instafy supports it).

## 0.1.2 (2026-10-26)

- **Empty answers ask the next provider.** An empty answer from the place search moves on down the `geocode` chain
  (Wikipedia's coordinates, then the OpenStreetMap name search), so a small venue the first search lacks can still be
  found. `lookup-providers.json` gains `chain_rules`: `places` keeps `on_empty: "stop"`, because an empty Overpass
  answer is authoritative there. `not_found` now means a complete provider answered empty and no provider failed;
  nothing found while one could not answer is `unavailable`.
- **Partial results say so.** An answer from a fallback provider is `"status": "partial"`, with `via`, `data_reason`
  and `data_missing`; `geocode` and `add-point` print `PARTIAL: … — data may be incomplete` and the point carries
  `data_status: "partial"`; so does a `station` a fallback found. The map's card for such a point says "data may be
  incomplete" and its layer "partial data". `enrich --route-to` that routed only some options marks those walk times partial, so the
  verdict never calls one the shortest or longest. `overpassBatch` reports a batch that was not answered.
- **Time budget.** No command runs longer than 540 s: `--timeout 0` is that ceiling, not "no limit". `handoff
  --apply` has 420 s for the whole run, and the steps it starts inherit the deadline through
  `INSTAFY_JOB_DEADLINE`. Without a host clock, the pack's own turn clock caps an explicit `--timeout` and `handoff
  --apply` too: a command late in the turn gets only what is left before the turn's hard limit. A lookup chain keeps time back for its fallbacks, and one Overpass call takes at most 90 s
  across every mirror.
- **Polite to public services.** An HTTP 429 is never retried. That service, or that Overpass mirror, is not asked
  again by any command that turn, and not before its Retry-After. The User-Agent names a contact URL, and
  `INSTAFY_LOOKUP_CONTACT` adds the operator's. Providers declare `cache.ttl_s` from their caching terms. Photon's
  bias point is rounded to about 100 m, so nearby searches share a cached answer.
- **State that outlasts the turn.** Lookup health, rate-limit holds, slots, the Overpass lock and the shared answers
  live in `INSTAFY_CACHE_DIR`, the runtime's per-space folder, when it is set. Where the state folder cannot be
  written (no `INSTAFY_CACHE_DIR`, a read-only HOME), the slot locks fall back to the temporary folder, so the limit
  on concurrent requests to a service still holds. `.instafy-pack.json` declares the
  settings the pack reads (`"env": ["UW_*", "INSTAFY_LOOKUP_*"]`), so a runtime can pass them to the pack's processes.
- `SKILL.md` and `reference/data-sources.md`: facts come from pages the agent reads (`instafy web read` and the
  `instafy-web-research` skill, else `uw cite`). The map lookups only place pins, routes and areas, and a sign-in,
  CAPTCHA or 429 is final for the turn.

## 0.1.1 (2026-10-26)

- `SKILL.md`, `reference/itinerary.md` and `uw handoff --help` source facts with the pack's own `uw cite`; they
  named an Instafy command that released Instafy does not have.

## 0.1.0 (2026-10-26)

First public release of the interactive-map skill pack, moved out of the Instafy runtime into its own repository.

- `skills/interactive-map/`: `SKILL.md`, references, the `uw` CLI (no dependencies, Node 22 or later) and the
  starter site with the map engine and MapLibre GL JS 5.24.0.
- Commands for places, lines, routes, walk areas, trip legs and day plans, lodging near a station, air quality,
  calm-vs-lively estimates, named areas, doorstep street photos, Wikipedia, dataset adapters, the question/verdict
  block, a dev server, an agent host for bound sites, snapshots and validation.
- Pack manifest schema 1 (`engines.node`, `tree_sha256`), generated by `scripts/manifest.mjs`.
- Licence AGPL-3.0-only, with third-party notices for vendored code, the basemap style and data credits. Sites
  built from the starter carry `engine/LICENSE`, `engine/THIRD_PARTY_NOTICES.md` and `STYLE-LICENSE.md`.
- Release asset: a reproducible tarball of `skills/interactive-map/` plus its sha256.
