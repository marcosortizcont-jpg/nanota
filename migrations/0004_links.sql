-- NaNota: links de referência (YouTube, Spotify, Deezer, outro) por música
ALTER TABLE songs ADD COLUMN links TEXT NOT NULL DEFAULT '{}';
