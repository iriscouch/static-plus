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
  , 'suffix'   : '-baking'
  , 'output'   : null
  , 'source'   : null
  }, function(module, exports, DEFS, require) {

module.exports = Builder


var fs = require('fs')
  , path = require('path')
  , util = require('util')
  , fixed = require('fixed-event')
  , follow = require('follow')
  , rimraf = require('rimraf')
  , assert = require('assert')
  , request = require('request')
  , handlebars = require('handlebars')
  , querystring = require('querystring')

var lib = require('../lib')


util.inherits(Builder, fixed.EventEmitter)
function Builder (opts) {
  var self = this;
  fixed.EventEmitter.call(self)

  opts = opts || {}
  if(typeof opts == 'string')
    opts = { 'db':opts }
  opts = defaultable.merge(opts, DEFS)

  self.log = lib.getLogger(opts.db || 'Builder')

  self.template = opts.template
  self.source   = opts.source
  self.target   = opts.target
  self.autostop = opts.autostop
  self.caught_up = false
  self.pending  = {}             // Pending changes that have not been written out yet

  // Prep work to do
  self.preparing = { 'source': new fixed.Once
                   , 'target': new fixed.Once
                   , 'template': new fixed.Once
                   }

  self.feed = new follow.Feed
  if(opts.autostart) {
    // Give it one tick for the caller to hook into events.
    self.log.debug('Autostart')
    process.nextTick(function() {
      self.fetch()
    })
  }
}


Builder.prototype.prep_target = function() {
  var self = this;

  if(self.preparing.target.task)
    return self.preparing.target

  if(typeof self.target == 'object' && !Array.isArray(self.target)) {
    self.log.debug('Using an in-memory object for target')
    self.preparing.target.job(function(callback) {
      callback(null, self.target)
    })
  }

  else if(typeof self.target == 'string' && self.target.match(/^https?:\/\//))
    self.preparing.target.job(function(callback) {
      self.prep_target_url(callback)
    })

  else if(typeof self.target == 'string')
    self.preparing.target.job(function(callback) {
      self.prep_target_dir(callback)
    })

  else
    throw new Error('Must set .target to a directory name or an object')

  return self.preparing.target
}


Builder.prototype.prep_target_url = function(callback) {
  var self = this

  lib.request({uri:self.target, json:true}, function(er, res) {
    if(er)
      return callback(er)

    if(res.statusCode == 200 && res.body._id) {
      self.log.info('Deploying to document', {'id':res.body._id, 'rev':res.body._rev})
      self.target += DEFS.suffix
      return callback(null, self.target)
    }

    if(res.statusCode == 200 && res.body.couchdb == 'Welcome')
      return callback(new Error('Output must be a couch database URL, not a couch server URL'))

    if(res.statusCode == 404 && res.body.error == 'not_found') {
      var parent = path.dirname(self.target)
      self.log.debug('Missing target document, checking for database', {'target':self.target, 'parent':parent})
      lib.request({uri:parent, json:true}, function(er, res) {
        if(er || res.statusCode != 200 || !res.body || !res.body.db_name)
          return callback(new Error('Output URL is not a document in a CouchDB database'))

        self.log.debug('Confirmed couch database for target', {target:self.target})
        self.target += DEFS.suffix

        self.emit('target', self.target)
        return callback(null, self.target)
      })
    }
  })
}


Builder.prototype.prep_target_dir = function(callback) {
  var self = this

  fs.lstat(self.target, function(er, stat) {
    if(er && er.code != 'ENOENT')
      return callback(er)

    else if(!er && stat.isDirectory()) {
      self.log.info('Cleaning target directory: ' + self.target)
      rimraf(self.target, {gently:self.target}, function(er) {
        if(er)
          return callback(er)
        self.log.debug('Cleaned: ' + self.target)
        fs.mkdir(self.target, 0777, function(er, res) {
          if(er)
            return callback(er)

          self.emit('target', self.target)
          return callback(null, self.target)
        })
      })
    }

    else if(er && er.code == 'ENOENT') {
      var dirs = path.resolve(self.target).split(/\//)
        , dir = '/'
      self.log.debug('Creating target directory', {'dirs':dirs})
      mkdir()
      function mkdir() {
        if(dirs.length == 0) {
          self.emit('target', self.target)
          return callback(null, self.target)
        }

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
      callback(new Error('Cannot use target location: ' + self.target))
  })
}


Builder.prototype.prep_source = function() {
  var self = this;

  if(self.preparing.source.task)
    return self.preparing.source

  assert.ok(self.source, 'Must set .source to a CouchDB database URL')
  assert.ok(self.source.match(/^https?:\/\//), 'Must set .source to a CouchDB database URL')

  self.preparing.source.job(check_source)
  return self.preparing.source

  function check_source(callback) {
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

      self.emit('source', res.body)
      return callback(null, res.body)
    })
  }
}


Builder.prototype.prep_template = function() {
  var self = this;

  if(self.preparing.template.task)
    return self.preparing.template

  assert.ok(self.template, 'Must set .template to a filename or function')
  assert.ok(typeof self.template == 'function' || typeof self.template == 'string',
            'Unknown template type: ' + typeof self.template)

  if(typeof self.template == 'function')
    self.preparing.template.job(return_template)
  else if(typeof self.template == 'string')
    self.preparing.template.job(load_template)

  return self.preparing.template

  function return_template(callback) {
    self.emit('template', self.template)
    callback(null, self.template)
  }

  function load_template(callback) {
    fs.readFile(self.template, 'utf8', function(er, body) {
      if(er)
        return callback(er)

      self.template = handlebars.compile(body)
      self.log.debug('Compiled template', {'content':self.template.toString()})

      self.emit('template', self.template)
      callback(null, self.template)
    })
  }
}


Builder.prototype.fetch = function() {
  var self = this;

  var done = {}
  self.prep_source().on_done(prepped('source'))
  self.prep_target().on_done(prepped('target'))
  self.prep_template().on_done(prepped('template'))

  function prepped(type) {
    return function(er) {
      if(er)
        return self.die(er)
      done[type] = true
      if(done.source && done.target && done.template)
        begin_fetch()
    }
  }

  function begin_fetch() {
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
  self.log.debug('Made page', { 'id':page.id, 'length':page.content.length })
  self.page(page)
}


Builder.prototype.page = function(id, content) {
  var self = this

  var page
  if(typeof id == 'string' && typeof content == 'string')
    page = { 'id':id, 'content':content }
  else if(typeof id == 'object' && !Array.isArray(id))
    page = id
  else
    throw new Error('Unknown page value: ' + util.inspect(id))

  self.pending[page.id] = page
  self.log.debug('Pending page', {'id':page.id})

  self.prep_target().on_done(function(er) {
    if(er)
      return self.die(er)

    if(typeof self.target == 'object')
      return self.output_object(page)

    else if(typeof self.target == 'string' && self.target.match(/^https?:\/\//))
      self.output_url(page)

    else if(typeof self.target == 'string')
      self.output_dir(page)

    else
      self.die(new Error('Not implemented: building output for ' + output_type))
  })
}


Builder.prototype.output_object = function(page) {
  var self = this

  self.target[page.id] = page.content
  self.page_done(page)
}


Builder.prototype.output_url = function(page) {
  var self = this

  return self.die(new Error('Output to a URL is not implemented'))
}


Builder.prototype.output_dir = function(page) {
  var self = this

  page.path = path.join(self.target, page.id) + '.html'
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
    self.log.info('Deploying', {'output':self.target})
    self.deploy()
  }
}


Builder.prototype.deploy = function() {
  var self = this

  self.log.debug('Deploying to target type: ' + typeof self.target)
  if(typeof self.target == 'object')
    self.log.debug('Nothing to do deploying to an object')
  else if(typeof self.target == 'string')
    self.log.debug('Nothing to do deploying to files')
  else
    return self.emit('error', new Error('Deploy to ' + (typeof self.target) + ' not implemented'))

  self.emit('deploy', self.target)
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
