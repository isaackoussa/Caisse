// Fonction Netlify qui sert toutes les routes /api/* (données dans Netlify Blobs).
import { getStore } from '@netlify/blobs';
import { makeHandler } from './lib/api.mjs';

export default makeHandler(getStore);

export const config = { path: '/api/*' };
