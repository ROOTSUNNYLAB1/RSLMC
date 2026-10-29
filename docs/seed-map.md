# The seed map (Map → Chunkbase)

RSLMC does not draw a seed map itself. [Chunkbase](https://www.chunkbase.com/apps/seed-map) does
that job better than any panel will, so the Map page hands it the one thing it needs — your world's
real seed — together with the version, dimension, coordinates and zoom you are looking at.

This page is written down because two of its decisions look like bugs until you know why.

## What the panel actually does

1. Reads `level.dat` of the world folder you pick, with the panel's own NBT reader
   (`src/minecraft/nbt.ts`). Nothing is typed in by hand and nothing is guessed: if the file has no
   seed, the page says **No seed yet** instead of showing a made-up number.
2. Maps your server version onto a Chunkbase platform id (`src/minecraft/chunkbase.ts`). An exact
   profile is used when it exists; otherwise the newest profile that is *not newer* than your
   version — because a newer generator would draw terrain your server will never produce. The card
   says which profile was used, and says so plainly when it is not exact.
3. Builds the link:

   ```
   https://www.chunkbase.com/apps/seed-map#seed=<seed>&platform=<java_x_y[_z]>&dimension=overworld|nether|end&x=<int>&z=<int>&zoom=<0.125–2>
   ```

4. `GET /api/servers/:id/seed-map` returns the same thing as JSON — platform, `platformIsExact`,
   the primary world and one link per dimension for **every** world folder on disk — so anything
   scripted sees exactly what the buttons open.

## Why the map opens in a new tab

`https://www.chunkbase.com/apps/seed-map` answers with:

```
X-Frame-Options: DENY
```

That header is a hard "no" from their server: no browser will render the page inside an `<iframe>`,
and no amount of panel-side work changes it. RSLMC could proxy the site, strip the header and
pretend to embed it — that breaks their terms, breaks their scripts, and would still not be the real
map. So **Open seed map** launches the deep link in a new tab, and the page states the reason
instead of showing an empty frame or a fake screenshot.

## Privacy

The seed travels in the **URL fragment** (`#…`). Browsers never send the fragment to a server, so
the panel's own access log, its reverse proxy and Chunkbase's server all see only
`/apps/seed-map` — the seed is handed to the page that you opened, in your browser. Nothing about
your world is uploaded to RSLMC's update feed or anywhere else.

## Seeded or rendered — pick the right one

| Question | Use |
| -------- | --- |
| "Where is the nearest village / stronghold / slime chunk in this world?" | Seed map — it *predicts* generated structure from the seed. |
| "What did my players actually build, and what is generated so far?" | BlueMap render (below the seed map card) — it *renders the chunks that exist on disk*. |

They disagree by design, and both cards on the page say which one you are looking at.

## 64-bit seeds

A Minecraft seed is a signed 64-bit number, which does not survive JavaScript's `Number()`. The NBT
reader keeps the exact digits of every `long` tag, so a seed like `-4172144997902289642` is passed
through byte-for-byte instead of being rounded into a different world.
`tests/nbt-seed.test.ts` pins this down, together with the modern (`Data.WorldGenSettings.seed`),
flat (`Data.RandomSeed`) and pre-1.13 (`Data.Level.RandomSeed`) layouts.

## Platform ids

`java_1_7 … java_1_21_9` and `java_26_1 … java_26_4` (Minecraft moved to a `26.x` scheme after
1.21.9). Snapshot names such as `24w14a` are not versions and are never treated as one: the panel
falls back to the closest published profile rather than inventing `java_24_0`.
