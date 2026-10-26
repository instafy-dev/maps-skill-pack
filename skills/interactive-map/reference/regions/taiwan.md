# Region notes: Taiwan

Read with `reference/itinerary.md` when a trip or map is in Taiwan. These are facts about the place and its open
data; the steps stay the generic ones.

## Open data the commands use here (`uw adapter list --at <lng,lat>`)

- **Lodging register** (adapter `tw-hotels`; data.gov.tw 7780 + Taipei 135464): every licensed hotel and B&B with
  coordinates as filed. `uw stay` and `uw add-point` use it first; `uw adapter tw-hotels <site> --layer stays
  --records` adds licence chips. Its filed rates (`tw_price_min/max`) are not prices: never quote them as one.
- **Taipei Metro** (adapter `tw-metro`; data.gov.tw 131734 + 128428): every station with its entrances;
  `uw places --kinds mrt_station` uses it in the Taipei area.
- **Night markets** (adapter `tw-night-markets`): `uw adapter tw-night-markets <site> --around hotels --radius 1500
  --add-osm`, then `uw enrich <site> --layer hotels --nearest nightmarkets` (watched in the Sleep verdict).
- Credit (the licence is void without it; the adapters add it): "… (data.gov.tw，政府資料開放授權條款第1版)".

## Rail

- High-speed rail (THSR) runs only down the west side (Taipei – Taoyuan – Hsinchu – Taichung – Chiayi – Tainan –
  Zuoying). The east coast (Yilan, Hualien, Taitung) is TRA only: never suggest HSR there.
- THSR stations are often outside town: Tainan, Taichung, Chiayi, Hsinchu, and Zuoying for Kaohsiung
  (`uw station <site> --city Tainan --kind hsr --id tainan-hsr --nights 0`; for Kaohsiung `--city Zuoying`).
- Hualien and Taitung stations are a long walk from the old centre: stays in town for stops with full days.
- Timetables: TRA `https://tip.railway.gov.tw/tra-tip-web/tip/tip001/tip112/gobytime`, THSR
  `https://www.thsrc.com.tw/ArticleContent/a3b630bb-1066-4352-a1ef-58c7b4e8ef7c`. The official timetable API (TDX)
  needs a platform key (data-sources.md); without one, legs carry typical times from Wikivoyage or the operator page.

## Before you write a day

- Taroko Gorge: most trails were closed after the April 2024 earthquake; check the national park's page this turn.
- Typhoon season (roughly July to October) closes east-coast roads and ferries: say so for those dates.
