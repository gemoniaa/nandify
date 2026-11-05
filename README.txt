SETUP
1. Install Node.js 18 or newer
2. In this folder run:  npm install
3. Then run:            npm start
4. Open http://127.0.0.1:3000

Songs play in the official YouTube player (the small video box above the mini player,
and at the top of the Now Playing screen). Keep it visible, YouTube requires that.

Tabs: Home, Search, Your Library.
Tap the mini player to open Now Playing (lyrics, queue, like, shuffle).
Tap the round N button at the top to change the theme (Classic, Kawaii, Gotham).
Liked songs and playlists are saved in your browser only.

Smart shuffle: turn on the shuffle button. After every few songs the queue gets one new song picked from your liked and recent songs (server route /api/recommend, scoring in recommend.js).

Artists: search shows an Artists row. Tap one to see songs, play, shuffle and follow. Followed artists show in Home and Your Library.
Listen together: menu (three dots at the top), Listen together, Start a session.
  Friends enter the code or open the link. The host controls playback, everyone plays in their own YouTube player.
  Guests ask the server for news about once a second, so it works from any network.

FRIENDS ON OTHER WI-FI (public link)
  Your server runs on your computer, so friends need a public web address that points to it. The easy free way
  is a Cloudflare quick tunnel (no account needed):
    1. Install cloudflared  (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
    2. Keep the app running (npm start), then in a second terminal run:
         cloudflared tunnel --url http://127.0.0.1:3000
    3. It prints an address like https://something.trycloudflare.com
    4. Open THAT address in your own browser, start the session there, and send the invite link to friends.
  Your computer must stay on while you listen. The address changes every time you restart the tunnel.
  Optional: set PUBLIC_URL=https://something.trycloudflare.com before npm start so the invite link is always right.
  Hosting on a cloud service also works (it must run node server.js), but YouTube often blocks search
  from cloud servers, so the tunnel from your own computer is the safer choice.

SONGS THAT WILL NOT PLAY
  Some labels forbid playing their songs outside YouTube. The app then looks for another upload of the same
  song (lyric video, audio upload) and plays that. If none exists the song is skipped.

PUTTING IT ONLINE
  Read DEPLOY.md. It shows how to push to GitHub, run it free on Render, and turn on Google sign in
  (your YouTube Music playlists) and the search backup key.

SMART SHUFFLE
  It is its own switch (sparkle button) in Now Playing and on playlist pages. Shuffle only changes the order.
  Smart shuffle adds new songs you may like after every few songs.
