# Third-party notices

The interactive-map skill pack is licensed under the GNU Affero General Public License v3.0 only (`LICENSE`).
Some files in it come from other projects and keep their own licences, listed below. Sites made from `starter/`
contain these files too: keep this notice and the licence files with them.

## Vendored code

### MapLibre GL JS 5.24.0

- Files: `starter/engine/vendor/maplibre-gl.js`, `starter/engine/vendor/maplibre-gl.css`
- Licence: BSD-3-Clause. Full text, including the notices for the code MapLibre itself contains (mapbox-gl-js
  v1.13 and earlier, BSD-3-Clause; glfx.js, MIT; a portion of d3-color, BSD-3-Clause), is in
  `starter/engine/vendor/LICENSE.txt`.
- Source: https://github.com/maplibre/maplibre-gl-js/tree/v5.24.0

### Basemap style (OpenFreeMap Liberty)

- File: `starter/style.json` (copied from OpenFreeMap's Liberty style, then edited)
- Licences: see `starter/STYLE-LICENSE.md`. In short: OpenFreeMap styles, MIT (© 2023 Zsolt Ero); Liberty is a
  fork of OSM Liberty (Maputnik), itself a fork of OSM Bright: style code BSD-3-Clause (© Mapbox and contributors,
  OpenMapTiles), design CC BY 3.0 / CC BY 4.0.

## Loaded at runtime (not part of this repository)

The style and the CLI fetch these from their providers. They are not redistributed here, but their credits must
stay visible on every map. The engine shows them automatically; keep them when restyling.

| What | Provider | Licence / terms | Credit |
|---|---|---|---|
| Vector tiles, fonts, sprites | OpenFreeMap | Tiles: data ODbL, schema CC BY 4.0. Fonts: Noto Sans, SIL OFL 1.1. Icons: Maki, CC0 | "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" |
| Map data | OpenStreetMap contributors | ODbL 1.0 | "© OpenStreetMap contributors" |
| Tile schema | OpenMapTiles | CC BY 4.0 | "© OpenMapTiles" with a link to openmaptiles.org |
| Shaded relief at low zoom | Natural Earth | Public domain | none required |
| Terrain | AWS Terrain Tiles (Mapzen) | per-source credits | https://github.com/tilezen/joerd/blob/master/docs/attribution.md |
| Search | Photon (komoot) | data ODbL | OSM credit |
| Routes and walk areas | FOSSGIS OSRM and Valhalla | data ODbL; service terms of FOSSGIS | OSM credit plus the routing service |
| Air quality, weather | Open-Meteo (CAMS / ECMWF) | CC BY 4.0 | "Open-Meteo" |
| Articles | Wikipedia | CC BY-SA 4.0 | the article and "Wikipedia" |
| Street photos | Panoramax / Mapillary | CC BY-SA 4.0 (per photo) | author and licence per photo |
| Taiwan registers, metro, night markets | data.gov.tw, data.taipei | OGDL-Taiwan 1.0 | "(data.gov.tw，政府資料開放授權條款第1版)" (the adapters write it) |

`reference/data-sources.md` has the details and the limits of each free service.
