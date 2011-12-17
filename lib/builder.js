// Builder
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

var defaultable = require('defaultable')

defaultable(module,
  { 'autostart': false
  , 'autostop' : false
  , 'template' : null
  , 'output'   : null
  , 'source'   : null
  }, function(module, exports, DEFS, require) {

module.exports = Builder


var fs = require('fs')
  , path = require('path')
  , util = require('util')
  , events = require('events')
  , follow = require('follow')
  , rimraf = require('rimraf')
  , assert = require('assert')
  , request = require('request')
  , handlebars = require('handlebars')
  , querystring = require('querystring')

var lib = require('../lib')


util.inherits(Builder, events.EventEmitter)
function Builder (opts) {
  var self = this;

  opts = opts || {}
  if(typeof opts == 'string')
    opts = { 'db':opts }
  opts = defaultable.merge(opts, DEFS)

  self.log = lib.getLogger(opts.db || 'Builder')

  self.template = opts.template
  self.output   = opts.output
  self.source   = opts.source
  self.autostop = opts.autostop
  self.caught_up = false
  self.pending  = {}             // Pending changes that have not been written out yet

  self.feed = new follow.Feed
  self.started = false;

  // For an autostart, give it one tick for the caller to hook into events.
  if(opts.autostart) {
    self.log.debug('Autostart')
    process.nextTick(function() {
      self.start()
    })
  }
}


Builder.prototype.start = function() {
  var self = this;

  if(self.started)
    return

  var ok = {}
  self.prep_template(function(er, result) { did('template', er, result) })
  self.prep_output(function(er, result) { did('output', er, result) })
  self.prep_couch(function(er, result) { did('source', er, result) })

  function did(label, er, result) {
    if(er)
      return self.emit('error', er)
    self.emit(label, result)

    ok[label] = true
    if(ok.template && ok.output && ok.source) {
      if(self.dead)
        return self.log.debug('Prep done, but stopping')

      self.log.info('Starting')
      self.started = true
      self.emit('start')
      self.fetch()
    }
  }
}


Builder.prototype.prep_output = function(callback) {
  var self = this;

  assert.ok(self.output, 'Must set .output to a directory name')
  var output_type = typeof self.output

  if(output_type == 'object') {
    self.log.debug('Using an in-memory object for output')
    return callback(null, self.output)
  }

  else if(output_type == 'string' && self.output.match(/^https?:\/\//))
    self.output_url(callback)

  else if(output_type == 'string')
    self.output_dir(callback)

  else
    throw new Error('Must set .output to a directory name or an object')
}


Builder.prototype.output_url = function(callback) {
  var self = this

  lib.request({uri:self.output, json:true}, function(er, res) {
    if(er)
      return callback(er)

    if(res.statusCode == 200 && res.body._id) {
      self.log.info('Deploying to document', {'id':res.body._id, 'rev':res.body._rev})
      self.output += '-baking'
      return callback(null, self.output)
    }

    if(res.statusCode == 200 && res.body.couchdb == 'Welcome')
      return callback(new Error('Output must be a couch database URL, not a couch server URL'))

    if(res.statusCode == 404 && res.body.error == 'not_found') {
      var parent = path.dirname(self.output)
      self.log.debug('Missing output document, checking for database', {'output':self.output, 'parent':parent})
      lib.request({uri:parent, json:true}, function(er, res) {
        if(er || res.statusCode != 200 || !res.body || !res.body.db_name)
          return callback(new Error('Output URL is not a document in a CouchDB database'))

        self.log.debug('Confirmed couch database for output', {output:self.output})
        self.output += '-baking'
        return callback(null, self.output)
      })
    }
  })
}


Builder.prototype.output_dir = function(callback) {
  var self = this

  fs.lstat(self.output, function(er, stat) {
    if(er && er.code != 'ENOENT')
      return callback(er)

    else if(!er && stat.isDirectory()) {
      self.log.info('Cleaning output directory: ' + self.output)
      rimraf(self.output, {gently:self.output}, function(er) {
        if(er)
          return callback(er)
        self.log.debug('Cleaned: ' + self.output)
        fs.mkdir(self.output, 0777, function(er, res) {
          if(er)
            return callback(er)
          return callback(null, self.output)
        })
      })
    }

    else if(er && er.code == 'ENOENT') {
      var dirs = path.resolve(self.output).split(/\//)
        , dir = '/'
      self.log.debug('Creating output directory', {'dirs':dirs})
      mkdir()
      function mkdir() {
        if(dirs.length == 0)
          return callback(null, self.output)

        dir = path.join(dir, dirs.shift())
        path.exists(dir, function(is_dir) {
          if(is_dir)
            return mkdir()

          fs.mkdir(dir, 0777, function(er) {
            if(er)
              return callback(er)
            mkdir()
          })
        })
      }
    }

    else
      callback(new Error('Cannot use output location: ' + self.output))
  })
}


Builder.prototype.prep_couch = function(callback) {
  var self = this;

  assert.ok(self.source, 'Must set .source to a CouchDB database URL')
  assert.ok(self.source.match(/^https?:\/\//), 'Must set .source to a CouchDB database URL')

  self.log.debug('Checking source DB: ' + self.source)
  lib.request({uri:self.source, json:true}, function(er, res) {
    if(er)
      return callback(er)
    if(res.statusCode != 200)
      return callback(new Error('Bad response: ' + self.source))
    if(res.body.couchdb)
      return callback(new Error('Need a DB URL, not a Couch URL: ' + self.source))

    if(!res.body.db_name)
      return callback(new Error('Unknown database response: ' + JSON.stringify(res.body)))

    //if(res.body.update_seq == 0)
    //  return callback(new Error('No documents in source database: ' + self.source))

    return callback(null, res.body)
  })
}


Builder.prototype.prep_template = function(callback) {
  var self = this;

  assert.ok(self.template, 'Must set .template to a filename or function')
  assert.ok(typeof self.template == 'function' || typeof self.template == 'string',
            'Unknown template type: ' + typeof self.template)

  if(typeof self.template == 'function')
    callback(null, self.template)

  else if(typeof self.template == 'string')
    fs.readFile(self.template, 'utf8', function(er, body) {
      if(er)
        return callback(er)

      self.template = handlebars.compile(body)
      self.log.debug(self.template.toString())
      return callback(null, self.template)
    })
}


Builder.prototype.fetch = function() {
  var self = this;

  self.emit('fetch')
  self.log.debug('Fetching: ' + self.source)

  self.feed.include_docs = true
  self.feed.db = self.source

  if(self.since)
    self.feed.since = self.since
  if(self.limit)
    self.feed.limit = self.limit
  if(self.inactivity_ms)
    self.feed.inactivity_ms = self.inactivity_ms

  process.nextTick(function() { self.feed.follow() })
  self.feed.on('error' , function(er) {
    self.feed.stop()
    self.emit('error', er)
  })

  self.feed.on('catchup', function(seq) {
    self.caught_up = true
  })

  self.feed.on('change', function(change) {
    self.log.debug('Update', change)
    self.on_change(change)
  })
}


Builder.prototype.on_change = function(change) {
  var self = this

  var er, page = {}
  try       { page.content = self.template(change.doc) }
  catch (e) { er = e }

  if(er)
    return self.die(er)
  if(typeof page.content != 'string')
    return self.die(new Error('Bad template output for change '+change.seq+', doc ' + change.id))

  self.log.debug('Built content', {'length':page.content.length})

  page.id   = change.id
  page.name = change.id
  self.log.debug('Made page', { 'id':page.id, 'name':page.name, 'length':page.content.length })

  self.pending[page.id] = page

  var method = 'output_' + (typeof self.output)
  if(method in self)
    return self[method](page)
  return self.die(new Error('Building for ' + (typeof self.output) + ' not implemented'))
}


Builder.prototype.output_object = function(page) {
  var self = this

  self.output[page.name] = page.content
  self.page_done(page)
}


// "String" output is a directory name.
Builder.prototype.output_string = function(page) {
  var self = this

  page.path = path.join(self.output, page.name) + '.html'
  self.log.debug('Writing page file', {'path':page.path})
  fs.writeFile(page.path, page.content, 'utf8', function (er) {
    if(er)
      return self.die(er)
    self.page_done(page)
  })
}


Builder.prototype.page_done = function(page) {
  var self = this

  delete self.pending[page.id]
  self.emit('page', page)
  if(self.caught_up && Object.keys(self.pending).length == 0) {
    self.log.debug('All pages done, and caught up with the feed; time to deploy')
    self.deploy()
  }
}


Builder.prototype.deploy = function() {
  var self = this

  self.log.debug('Deploying to output type: ' + typeof self.output)
  if(typeof self.output == 'object')
    self.log.debug('Nothing to do deploying to an object')
  else if(typeof self.output == 'string')
    self.log.debug('Nothing to do deploying to files')
  else
    return self.emit('error', new Error('Deploy to ' + (typeof self.output) + ' not implemented'))

  self.emit('deploy', self.output)
  if(self.autostop) {
    self.log.debug('Autostop')
    self.stop()
  }
}


Builder.prototype.stop = function(reason) {
  var self = this

  self.emit('stop', reason)
  self.die()
}

Builder.prototype.die = function(er) {
  var self = this

  self.log.debug('Stopping feed')
  self.feed.stop()

  self.dead = true
  self.emit('die', er)
  if(er)
    self.emit('error', er)
}

}) // defaultable
