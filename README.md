# Card Scanner

A small installable web app for your Android phone: photograph a business card, it reads the
details automatically, and you can search everything you've scanned by typing or by voice.

Everything is **local-first** — no account, no backend server. Your scanned cards live only in
the browser on your phone. The only outside network call is your phone talking directly to
Anthropic's API to read the text off a card photo.

## 1. Put it online (needed once, ~1 minute)

Android needs the app served over `https://` before it can be installed to the home screen.

**Using GitHub Pages** (works with a repo you already have, must be a **public** repo — Pages on
a private repo needs a paid GitHub plan):

1. Create a repo (e.g. `cardscanner`) and upload these files to its root via **Add file → Upload
   files**.
2. **Settings → Pages** → source = **Deploy from a branch**, branch = `main`, folder = `/ (root)`
   → Save.
3. After a minute, the same Settings → Pages screen shows your live link:
   `https://<your-username>.github.io/cardscanner/`.

**Or, zero-account alternative:** go to **https://app.netlify.com/drop**, drag this whole
`cardscanner` folder onto the page, and it gives you a live link immediately — no repo needed.
(Vercel or any other static host works too — it's plain HTML/CSS/JS, no build step required.)

## 2. Install it on your phone

1. Open the link from step 1 in **Chrome** on your Android phone.
2. Tap the **⋮** menu → **Add to Home screen** (Chrome may also prompt you automatically).
3. Open it from your home screen — it runs full-screen, like a normal app.

## 3. Add your API key (one-time)

1. Get an API key from the Anthropic Console: **console.anthropic.com** → API Keys.
2. In the app, go to the **Settings** tab, paste the key, and tap **Save settings**.
3. The key never leaves your phone — it's stored in the browser and sent only straight to
   Anthropic when you scan a card.
4. The default model (**Haiku 4.5**) is the cheapest option and works well for this. Switch to
   **Sonnet 5** in Settings if you want more accurate reads on messy/handwritten cards, at a
   higher per-scan cost.

## 4. Scanning, grouping and searching

- **Scan tab** → Take photo → point at the front of a business card. The app then asks if the
  card has anything useful on the back (extra numbers, a second language, a QR code) — scan it
  too or skip. Either way you land on an editable form — fix anything it got wrong, then Save.
  Both photos (if you scanned a back) are read together, so details found only on the back still
  end up in the card's fields.
- That form includes a **Group / category** field, pre-filled with a suggestion (e.g. "Shipyard",
  "Vendor / Supplier", "Client") based on the card's company/title. Accept it, pick a different
  existing group from the dropdown, or just type a new name to create your own category — nothing
  extra to set up.
- **Cards tab** lists everything you've scanned, with a row of group chips ("All", "Shipyard",
  "Client", …, "Uncategorized") — tap one to filter the list to that group, tap "All" to clear it.
- Type in the search box, or tap the 🎤 to search by voice (e.g. say a name, company, or group).
  Search also matches group names.
- Tap any card to see full details, edit it (including its group), or delete it.

## 5. Moving your cards to a new phone (backup/export)

Since cards are stored only on this device, use Export/Import to move or back them up:

1. On the old phone: **Settings → Export backup**. This downloads one JSON file containing every
   card (including its photo).
2. Send that file to the new phone any way you like (email, WhatsApp, Google Drive, etc.).
3. Install the app on the new phone (steps 1–2 above), then **Settings → Import backup** and pick
   the file. Cards already present (matched by ID) are skipped, so importing twice is harmless.

It's worth exporting a backup every so often regardless — clearing Chrome's site data for this
app, or uninstalling it, deletes the cards stored on that device.

## Notes and limits

- Scanning needs an internet connection (the photo is read by Anthropic's API). Browsing and
  searching cards you've already saved works offline.
- There's no cloud sync between devices by design — use Export/Import to move data around.
- Voice search uses Chrome's built-in speech recognition; you'll be asked for microphone
  permission the first time you use it.
