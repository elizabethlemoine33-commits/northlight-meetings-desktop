const webpack = require('webpack');
require('dotenv').config();

module.exports = {
  entry: './src/main.js',
  module: {
    rules: require('./webpack.rules'),
  },
  plugins: [
    new webpack.DefinePlugin({
      GOOGLE_CLIENT_ID:     JSON.stringify(process.env.GOOGLE_CLIENT_ID     || ''),
      GOOGLE_CLIENT_SECRET: JSON.stringify(process.env.GOOGLE_CLIENT_SECRET || ''),
    }),
  ],
};
