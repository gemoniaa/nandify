# Put Nandify online (GitHub + Render + Google sign in)

Simple words, step by step. Total time about 30 minutes.

## 1. First, one important thing

GitHub Pages can only show plain web pages. Nandify also has a small server (search, lyrics, listening
together), so it needs a place that can run Node. The easiest free place that reads straight from GitHub is
**Render**. Your friends can then open one web address from any Wi-Fi.

## 2. Put the code on GitHub

1. Make a new repository on github.com (private or public).
2. Unzip nandify, open a terminal in the folder, then:

```
git init
git add .
git commit -m "Nandify"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/nandify.git
git push -u origin main
```

The file `.gitignore` already keeps `node_modules` and `.env` out of GitHub. Never upload keys.

## 3. Run it on Render

1. Make a free account on render.com and connect your GitHub.
2. Click **New +**, then **Blueprint**, then pick your repo. (Or **New +**, **Web Service**, with Build
   command `npm install` and Start command `npm start`.)
3. When it asks for values, you can leave them empty for now. You will fill them in below.
4. After the first deploy you get an address like `https://nandify-xxxx.onrender.com`. Open it. Search works.
5. In Render, open **Environment** and add:
   - `PUBLIC_URL` = your Render address, for example `https://nandify-xxxx.onrender.com`
   - `YT_API_KEY` = see step 5 (recommended)
   - `GOOGLE_CLIENT_ID` = see step 4 (only for Google sign in)
   Save. Render restarts the app by itself.

Free plan notes: the app sleeps after about 15 minutes with nobody using it, and the first visit after that
takes up to a minute. Listening sessions live in memory, so a restart ends them. While friends are listening
the app stays awake.

## 4. Google sign in (your YouTube Music playlists)

This uses Google's official sign in and the YouTube Data API. It can only read playlists. Your login token stays
in the browser and is never sent to the Nandify server.

1. Go to console.cloud.google.com and make a new project (any name).
2. **APIs and Services**, **Library**, search **YouTube Data API v3**, click **Enable**.
3. **APIs and Services**, **OAuth consent screen**:
   - User type **External**, fill the app name and your email.
   - **Scopes**: add `.../auth/youtube.readonly`.
   - **Test users**: add the Gmail address of every friend who should sign in.
4. **Credentials**, **Create credentials**, **OAuth client ID**, type **Web application**:
   - **Authorized JavaScript origins**: add your Render address (for example
     `https://nandify-xxxx.onrender.com`). For testing on your computer also add
     `http://localhost:3000` and `http://127.0.0.1:3000`.
   - Leave redirect URIs empty.
   - Copy the **Client ID** (it ends with `.apps.googleusercontent.com`). It is not a secret.
5. Put it in Render as `GOOGLE_CLIENT_ID`. Open Nandify, go to **Your Library**, tap **Sign in with Google**.

Good to know:
- While the app is in **Testing**, only the test users you added can sign in (up to 100). Google shows a
  "not verified" screen to them. They tap **Advanced**, then **Continue**. To remove the warning for everyone you
  must send the app for Google verification (they check a privacy page and a short video).
- You see playlists that exist on your YouTube account, including ones made in YouTube Music. The
  "Liked on YouTube" row shows videos you liked. Music you only saved in the YouTube Music library may not
  show, because the official API does not give it out.

## 5. Search key (recommended on Render)

YouTube sometimes blocks searches that come from cloud servers. A free key gives a safe backup.

1. In the same Google Cloud project, **Credentials**, **Create credentials**, **API key**.
2. Click **Restrict key**, choose **YouTube Data API v3**.
3. Put it in Render as `YT_API_KEY`.

The backup search uses 100 of the 10,000 free daily units per search, so about 100 backup searches a day.

## 6. Check everything works

- Open your Render address on a phone with mobile data (not your Wi-Fi). Search a song and play it.
- Open the menu (three dots), **Listen together**, type a name, **Start a new session**.
- On a second phone open the invite link, type a name, **Join**. Both should hear the same song.
- Turn on **Smart shuffle** in Now Playing and play a playlist.
- In **Your Library** sign in with Google and open a playlist.

## 7. Before you share it

- Open `public/privacy.html` and add your contact email.
- Songs that a record label blocks outside YouTube are replaced by another upload when one exists. If none exists
  the app skips the song. That is a YouTube rule, not a bug.
