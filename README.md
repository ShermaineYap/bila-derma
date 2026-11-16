# Bila Derma

**Find the week your blood donation is needed most.**

Malaysia's blood donations fall on a predictable calendar: during Ramadan, the weeks after Hari Raya, Chinese New Year and the year-end holidays. Blood cannot be stockpiled for those weeks (red cells keep 35 to 42 days, platelets only 5, according to the National Blood Centre). Bila Derma reads the Ministry of Health's daily open data, forecasts the next 16 weeks for your state and blood group, and tells you which week to donate.

It runs entirely on GitHub: a scheduled GitHub Action downloads the data each morning, retrains and backtests the model, and publishes a static site to GitHub Pages. There is no server, database or login. What you type stays in your browser.

## What it does

- **Your week.** Choose blood group, state and last donation date. The app works out when you can give again and recommends the week, within the next 8 weeks of that date, where donations are forecast to be furthest below usual. If that week is full of public holidays (when centres may close), it suggests the week before instead. Add it to your calendar or share it.
- **The next 16 weeks.** A chart of the past 12 weeks and the 16-week forecast, each compared with the usual level, with an 80% range.
- **Right now.** Donations over the last 4 weeks against the past 12 months, nationally, for your state and for your blood group.
- **Live state map.** A tile map of Malaysia coloured by how each state's donations compare with its usual level. Tap a state to select it.
- **Donor poster (computer vision).** Take a selfie and [MediaPipe Selfie Segmentation](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) cuts you out of the background in the browser and places you on a shareable poster with your week and your state's forecast. The photo is processed on the device and never uploaded. PDN wants more young regular donors; a poster people actually want to post is a recruitment tool.
- **18 years in one picture.** A heatmap of every week since 2009. Because Ramadan arrives about 11 days earlier each year, its dip draws a diagonal stripe across the years; the 2020 Movement Control Order shows as a deep red block.
- **Four languages.** Bahasa Melayu, English, Chinese and Tamil.

## How accurate is it?

Rolling-origin backtest over the 104 weeks to 15 Nov 2026. The model was retrained every 13 weeks using only data available at the time, then asked to forecast weeks it had not seen.

| | Model | Last week | 4-week mean | Same week last year |
|---|---|---|---|---|
| National, 1 week ahead (MAPE) | **7.1%** | 11.6% | 11.8% | 11.9% |
| National, 1 to 16 weeks ahead (MAPE) | **7.3%** | 15.1% | 12.8% | 12.1% |
| 12 states/areas, 1 to 16 weeks ahead (WAPE) | **12.6%** | 21.2% | 17.3% | 18.8% |

The model beat all three simple rules in every one of the 12 areas. Example: forecasting 8 weeks ahead, it expected about 4,600 donations in the Hari Raya week of March 2026 (actual: 5,520), where "same week last year" said 9,800.

These figures are regenerated every day and published in `site/data/meta.json`.

## Method

- **Data:** [Daily Blood Donations by Blood Group](https://data.moh.gov.my/data-catalogue/blood_donations) and [by State](https://data.moh.gov.my/data-catalogue/blood_donations_state), Ministry of Health Malaysia (National Blood Centre), CC BY 4.0. Updated daily.
- **Series:** weekly totals (Monday to Sunday) for Malaysia and 12 areas, each for all groups and for O, A, B and AB: 65 series. Selangor and W.P. Kuala Lumpur are merged as Klang Valley because the publisher records mobile drives around Selangor and Putrajaya under Kuala Lumpur.
- **Model:** one scikit-learn `HistGradientBoostingRegressor` across all series, direct multi-horizon (1 to 16 weeks). Target: donations in week t+h divided by the 52-week mean at week t. Features: horizon, area, blood group, recent level ratios, same week last year, days of Ramadan, Hari Raya, the two weeks after Raya, Chinese New Year, Deepavali, Hari Raya Haji and year-end in the target week and in the same week last year, public holiday count, week of year. Trained on weeks since 2015, excluding COVID-19 weeks (16 Mar 2020 to 31 Oct 2021). Absolute-error loss, weighted by the square root of series volume.
- **Festive dates:** the [`holidays`](https://pypi.org/project/holidays/) package (Malaysia, W.P. Kuala Lumpur). Ramadan is approximated as the 30 days before Hari Raya Puasa.
- **Uncertainty:** the 80% range for each series comes from the 10th and 90th percentiles of actual/forecast in that series' backtest.

## Limitations

- These are **donations**, not blood stock or hospital demand. Fewer donations does not always mean a shortage, and this app never says "shortage".
- The data covers the 22 main donation sites integrated with BBISv2 (about 80% of donations). Perlis and W.P. Labuan are not included.
- In February 2026, Chinese New Year and the start of Ramadan overlapped and donations fell further than the model expected (about 8,700 a week against a forecast of about 11,200). 2027 has the same overlap, so the February 2027 forecast is likely optimistic.
- Festive dates for 2027 are estimates until officially announced.
- Some week-to-week drops reflect centres closing on public holidays, not fewer willing donors. That is why the app suggests the week before a holiday-heavy dip.
- The app does not decide whether anyone is eligible to donate. Staff at the donation centre confirm that on the day.
- The selfie segmenter is tuned for one or two people close to the camera; group photos and distant shots cut out less cleanly. The MediaPipe runtime is about 15 MB and loads only when someone adds a photo.
- Chinese and Tamil text was written with AI assistance and should be reviewed by native speakers.
- This is an independent student project, not an official service of the Ministry of Health or the National Blood Centre.

## Run it yourself

```bash
pip install -r pipeline/requirements.txt
python pipeline/build.py            # downloads data, trains, backtests, writes site/data/*.json (about 4 minutes)
python -m http.server -d site 8000  # open http://localhost:8000
```

Tests:

```bash
python -m pytest pipeline/tests -q
node --test tests/logic.test.mjs
```

## Deploy on GitHub

1. Push this repository to GitHub.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. The workflow in `.github/workflows/refresh.yml` runs on every push and daily at 11:30 MYT. It tests, rebuilds the forecast, commits the new data and deploys the site.

## Built with

Python, pandas, scikit-learn, vanilla JavaScript and SVG, MediaPipe Tasks Vision 1.2.3 (loaded from jsDelivr) with Google's `selfie_segmenter.tflite` model (Apache 2.0, stored in `site/models/`). Built with AI assistance (Claude) for code and translations. The data analysis, backtest numbers and limitations above are produced by the pipeline in this repository.

## Licence

Code: MIT. Data: Ministry of Health Malaysia, CC BY 4.0.
