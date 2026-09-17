# fastcache

A tiny in-memory LRU cache for Node.

## Install

    npm install fastcache

## Usage

    import { LRU } from "fastcache";
    const cache = new LRU({ max: 500 });
    cache.set("a", 1);

Set `FASTCACHE_DEBUG=1` to log evictions. Requires Node 18 or newer.
