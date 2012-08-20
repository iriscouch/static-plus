#!/usr/bin/env node

// The Static Plus command-line tool
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var fs = require('fs')
var URL = require('url')
  , util = require('util')

var sp = require('./api')
  , lib = require('./lib').defaults({ 'args': ['couch', 'db', 'hostname']
                                    , 'describe': { 'prefix': 'Production hostname prefix (default "www.")'
                                                  }
                                    })

function main(couch, db, hostname) {
  var site = new sp.Deuce
  site.db    = db
  site.hostname = hostname

  if('prefix' in lib.argv)
    site.production_prefix = lib.argv.prefix
  if('staging-prefix' in lib.argv)
    site.staging_prefix = lib.argv['staging-prefix']

  if(lib.argv.log)
    site.log.transports.console.level = lib.argv.log

  couch = URL.parse(couch)
  if(lib.argv.creds)
    couch.auth = lib.argv.creds

  site.couch = URL.format(couch)
  site.run()
}

if(require.main === module)
  main.apply(null, lib.argv._)
