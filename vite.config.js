import fs from 'fs';
import path from 'path';

// "Keep view" in the app (main.js) sends the map and the view here; the development server keeps
// the list in film/kept_views.json, with a picture of each view in film/kept/, for the film.
const keptViewsPath = path.resolve('film', 'kept_views.json');
const keptPicturesDirectory = path.resolve('film', 'kept');

function readKeptViews() {
  return fs.existsSync(keptViewsPath) ? JSON.parse(fs.readFileSync(keptViewsPath, 'utf8')) : [];
}

function keptPicturePath(keptView) {
  return path.join(keptPicturesDirectory, String(keptView.number).padStart(2, '0') + '.jpg');
}

function changeKeptViews(request) {
  const keptViews = readKeptViews();
  if (request.action === 'keep') {
    const keptView = Object.assign({ number: keptViews.length > 0 ? keptViews[keptViews.length - 1].number + 1 : 1, keptAt: new Date().toISOString() }, request.view);
    keptViews.push(keptView);
    fs.mkdirSync(keptPicturesDirectory, { recursive: true });
    fs.writeFileSync(keptPicturePath(keptView), Buffer.from(request.picture.split(',')[1], 'base64'));
  } else if (request.action === 'undo' && keptViews.length > 0) {
    fs.rmSync(keptPicturePath(keptViews.pop()), { force: true });
  }
  if (request.action !== 'count') {
    fs.writeFileSync(keptViewsPath, JSON.stringify(keptViews, null, 1));
  }
  const lastKeptView = keptViews[keptViews.length - 1];
  return { count: keptViews.length, lastSchemeInfo: lastKeptView ? lastKeptView.schemeInfo : '' };
}

const keptViewsPlugin = {
  name: 'kept-views',
  configureServer(server) {
    server.middlewares.use('/film/kept-views', function (request, response) {
      const bodyChunks = [];
      request.on('data', function (chunk) {
        bodyChunks.push(chunk);
      });
      request.on('end', function () {
        response.setHeader('Content-Type', 'application/json');
        try {
          response.end(JSON.stringify(changeKeptViews(JSON.parse(Buffer.concat(bodyChunks).toString('utf8')))));
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: String(error) }));
        }
      });
    });
  },
};

// The path tracer builds its search structure in worker threads. Vite's pre-bundling of
// dependencies would break the worker's reference to its own file, so that package is left as it is.
export default {
  plugins: [keptViewsPlugin],
  optimizeDeps: {
    exclude: ['three-mesh-bvh'],
  },
  worker: {
    format: 'es',
  },
  // the film's footage and frames change while it is being made; the app does not use them
  server: {
    watch: {
      ignored: ['**/film/**'],
    },
  },
};
