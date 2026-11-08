-- Remove the Minecraft flag the panel itself put on Python/Node servers.
--
-- The create route defaulted `server_args` to 'nogui' for every software, which is a Minecraft flag.
-- App servers created before that default was fixed therefore store it, and it reached their command
-- line: `node index.js nogui`. Only the exact old default is cleared — anything an operator actually
-- typed is left alone, and the Startup page can set arguments again at any time.
UPDATE servers SET server_args = '' WHERE software IN ('python', 'node') AND server_args = 'nogui';
