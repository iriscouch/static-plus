// Deuce -- second builder idea
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

require('defaultable')(module,
  { 'namespace': 'SP'
  , 'production': 'SP-production'
  , 'staging'   : 'SP-staging'
  // 'autostart': false
  //, 'autostop' : false
  //, 'partials' : {}
  //, 'helpers'  : {}
  //, 'cooldown' : 100
  }, function(module, exports, DEFS, require) {

module.exports = Builder


var fs = require('fs')
var URL = require('url')
var txn = require('txn')
var GFM = require('github-flavored-markdown')
var path = require('path')
var util = require('util')
var async = require('async')
var fixed = require('fixed-event')
var follow = require('follow')
var assert = require('assert')
var request = require('request')
var package = require('./package.json')
var handlebars = require('handlebars')
var querystring = require('querystring')

var builder_id = 0

util.inherits(Builder, fixed.EventEmitter)
function Builder () {
  var self = this
  fixed.EventEmitter.call(self)

  builder_id += 1
  self.id = builder_id
  self.log = console

  self.production_prefix = 'www.'
  self.staging_prefix    = 'staging.'

  self.couch = null
  self.db    = null
  self.hostname = null

  // Keep state from the incoming document stream.
  self.docs        = {}
  self.attachments = {}
  self.pages_queue = {}

  //self.helpers  = {}
  //self.partials = {}
  //self.source   = opts.source
  //self.target   = opts.target
  self.namespace = DEFS.namespace
  self.is_read_only = false

  self.caught_up = false
}


Builder.prototype.run = function() {
  var self = this

  self.prep()
  self.on('prep', function() {
    self.set_config()
    self.on('config', function() {
      self.ddoc()
      self.on('ddoc', function() {
        self.follow()
      })
    })
  })
}


Builder.prototype.prep = function() {
  var self = this

  self.couch = self.couch.replace(/\/+$/, '')

  self.log.debug('Prepare couch', {'url':self.couch})
  request({'url':self.couch, 'json':true}, function(er, res) {
    if(er)
      return self.die(er)

    if(res.statusCode != 200 || res.body.couchdb != 'Welcome')
      return self.die(new Error('Bad CouchDB url: ' + self.couch))

    var session = self.couch + '/_session'
    self.log.debug('Check session', {'url':session})
    request({'url':session, 'json':true}, function(er, res) {
      if(er)
        return self.die(er)

      if(res.statusCode != 200 || !res.body.ok)
        return self.die(new Error('Bad session response: ' + JSON.stringify(res.body)))

      if(~ res.body.userCtx.roles.indexOf('_admin'))
        self.log.debug('Confirmed admin access', {'url':self.couch})
      else {
        er = new Error('Not admin')
        er.admin_fail = true
        return self.die(er)
      }

      self.fixed('prep')
    })
  })
}


Builder.prototype.set_config = function() {
  var self = this

  var config = [ [ 'vhosts', self.production_prefix + self.hostname, '/'+self.db+'/_design/'+DEFS.production+'/_rewrite' ]
               , [ 'vhosts', self.staging_prefix    + self.hostname, '/'+self.db+'/_design/'+DEFS.staging   +'/_rewrite' ]
               , [ 'httpd' , 'secure_rewrites'        , 'false'                                             ]
               ]

  async.forEach(config, set_config, configs_set)

  function set_config(cfg, to_async) {
    var url = self.couch + '/_config/' + cfg[0] + '/' + cfg[1]
    request.put({'url':url, 'json':cfg[2]}, function(er, res) {
      if(er)
        return to_async(er)
      if(res.statusCode != 200)
        return to_async(new Error('Bad config response: ' + JSON.stringify(res.body)))

      self.log.debug('Set config', {'section':cfg[0], 'key':cfg[1], 'val':cfg[2]})
      to_async()
    })
  }

  function configs_set(er) {
    if(er)
      self.die(er)
    else
      self.fixed('config')
  }
}


Builder.prototype.ddoc = function() {
  var self = this

  var url = self.couch + '/' + self.db
  self.log.debug('Create db', {'url':url})
  request.put({'url':url, 'json':true}, function(er, res) {
    if(er)
      return self.die(er)
    if(res.statusCode != 201 && res.statusCode != 412)
      return self.die(new Error('Bad create response: ' + JSON.stringify(res.body)))

    var id = '_design/' + DEFS.staging
    self.log.debug('Create ddoc', {'id':id})
    txn({'couch':self.couch, 'db':self.db, 'id':id, 'create':true}, build_ddoc, ddoc_built)
  })

  function build_ddoc(doc, to_txn) {
    var namespace = self.namespace

    doc.static_plus = { 'version'   : package.version
                      , 'created_at': new Date
                      //, 'pages'     : self.pages
                      , 'namespace' : namespace
                      }

    doc.rewrites = []
    doc.rewrites.push({'from':'_db'     , 'to':'../..'})
    doc.rewrites.push({'from':'_db/*'   , 'to':'../../*'})

    doc.rewrites.push({'from':'_couchdb'  , 'to':'../../..'})
    doc.rewrites.push({'from':'_couchdb/*', 'to':'../../../*'})

    doc.rewrites.push({'from':'', 'to':namespace})
    doc.rewrites.push({'from':'*', 'to':namespace+'/*'})

    if(! self.is_read_only)
      delete doc.validate_doc_update
    else
      doc.validate_doc_update = "" + function(newDoc, oldDoc, userCtx, secObj) {
        throw {'forbidden':'This Static+ database is read-only'}
      }

    doc._attachments = {}
    var attachments = ['request.js']
    async.forEach(attachments, attach_file, files_attached)

    function attach_file(name, to_async) {
      console.dir(require)
      console.log('trying %j', {name:name, def:require._defaultable})
      var path = __dirname + '/lib/' + name
      fs.readFile(path, function(er, body) {
        if(er)
          return to_async(er)

        var loc = self.namespace + '/' + name
        doc._attachments[loc] = {}
        doc._attachments[loc].data = body.toString('base64')
        doc._attachments[loc].content_type = 'application/javascript' // XXX

        self.log.debug('Attached builtin', {'location':loc, 'length':body.length})
        return to_async()
      })
    }

    function files_attached(er) {
      if(er)
        return to_txn(er)

      self.log.debug('Attached builtin files')
      to_txn()
    }
  }

  function ddoc_built(er, doc, result) {
    if(er)
      return self.die(er)

    self.log.debug('Created ddoc', {'id':doc._id, 'rev':doc._rev, 'tries':result.tries, 'fetches':result.fetches})
    if(result.tries > 1)
      self.log.warn('Multiple updates (conflicts) to store metadata', {'target':self.target, 'tries':result.tries})

    self.fixed('ddoc')
  }
}


Builder.prototype.follow = function() {
  var self = this;

  var db_url = self.couch + '/' + self.db
  self.log.debug('Follow', {'url':db_url})

  self.feed = new follow.Feed
  self.feed.db = db_url
  self.feed.include_docs = true
  self.feed.inactivity_ms = 24 * 60 * 60 * 1000 // 1 day
  //self.feed.inactivity_ms = 5 * 1000 // XXX

  self.feed.filter = function(doc) { return ! doc._id.match(/^_design\//) }

  process.nextTick(function() { self.feed.follow() })

  self.feed.on('error' , function(er) {
    self.die(er)
  })

  self.feed.on('catchup', function(seq) {
    self.log.debug('Feed caught up', {'id':self.id, 'seq':seq})
    self.caught_up = true
    self.push()
  })

  self.feed.on('change', function(change) {
    self.log.debug('Update', change)

    self.doc(change.doc)

    if(self.caught_up)
      self.push()
  })
}


Builder.prototype.doc = function(doc) {
  var self = this

  if(doc._deleted)
    return self.log.warn('Ignore deleted doc', {'id':doc._id})

  self.docs[doc._id] = doc

  var atts = doc._attachments || {}
  for (var name in atts) {
    self.attachments[name] = atts[name]
    self.attachments[name].url = self.couch + '/' + self.db + '/' + encodeURIComponent(doc._id) + '/' + name
  }

  if(doc.template && ('path' in doc))
    self.pages_queue[doc.path] = doc
}


Builder.prototype.push = function() {
  var self = this

  var paths = Object.keys(self.pages_queue)
  self.log.debug('Push', {'count':paths.length, 'paths':paths})

  async.forEach(paths, push_path, paths_pushed)

  function push_path(path, to_async) {
    self.publish(self.pages_queue[path], to_async)
  }

  function paths_pushed(er) {
    if(er)
      return self.die(er)

    if(paths.length > 0) {
      self.log.debug('Push complete')
      self.emit('push')
    }
  }
}


Builder.prototype.publish = function(doc, callback) {
  var self = this

  // All attachments must be known.
  var attachments = Object.keys(self.attachments).map(function(A) { return self.attachments[A] })
    , stubs = attachments.filter(function(A) { return A.stub })

  self.log.debug('Publish', {'id':doc._id, 'stubs_count':stubs.length})
  if(stubs.length > 0)
    return async.forEach(stubs, get_stub, stubs_got)

  function get_stub(stub, to_async) {
    request({'url':stub.url}, function(er, res) {
      if(er)
        return to_async(er)

      if(res.statusCode != 200)
        return to_async(new Error('Bad code '+res.statusCode+' ' + JSON.stringify(res.body)))

      delete stub.stub
      stub.body = res.body

      var template_types = [ 'text/html' ]
      if(!~ template_types.indexOf(stub.content_type))
        self.log.debug('Not a template type', {'type':stub.content_type})
      else {
        self.log.debug('Compile template', {'type':stub.content_type})
        stub.handlebars = handlebars.compile(stub.body)
      }

      return to_async()
    })
  }

  function stubs_got(er) {
    if(er)
      callback(er)
    else {
      self.log.debug('Re-run publish with no more stubs', {'count':stubs.length})
      self.publish(doc, callback)
    }
  }

  var attachment = self.attachments[doc.template]
    , template   = attachment && attachment.handlebars
    , body       = attachment && attachment.body

  if(!template && !body) {
    self.log.warn('No attachment for template', {'template':template})
    return callback()
  }

  var output = null
  if(!template)
    output = body
  else {
    // Build the scope for the template.

    // Lowest pri: all docs by id
    var scope = JSON.parse(JSON.stringify(self.docs))

    // Next pri: the contents of this document.
    for (var key in doc)
      scope[key] = JSON.parse(JSON.stringify(doc[key]))

    // Highest pri: The markdown helper.
    delete scope.markdown

    var partials = {}
      , helpers  = {}

    helpers.markdown = mk_markdown_helper(scope, partials, helpers)

    try {
      output = template(scope, {'partials':partials, 'helpers':helpers})
    } catch (er) {
      self.log.debug('Template error', {'keys':Object.keys(er), 'message':er.message, 'str':er.toString()})
      return callback(er)
    }
  }

  var ddoc_id = '_design/' + DEFS.staging
  txn({'couch':self.couch, 'db':self.db, 'id':ddoc_id}, attach_output, output_attached)

  function attach_output(ddoc, to_txn) {
    ddoc._attachments = ddoc._attachments || {}

    var name     = (self.namespace + '/' + doc.path).replace(/\/+$/, '')
      , exists   = (name in ddoc._attachments)

    self.log.debug('Attach', {'name':name, 'exists':exists, 'length':output.length})

    ddoc._attachments[name] = {}
    ddoc._attachments[name].data = new Buffer(output).toString('base64')
    ddoc._attachments[name].content_type = attachment.content_type

    // And again for the trailing slash path.
    name += '/'
    ddoc._attachments[name] = {}
    ddoc._attachments[name].data = new Buffer(output).toString('base64')
    ddoc._attachments[name].content_type = attachment.content_type

    return to_txn()
  }

  function output_attached(er) {
    if(er)
      return callback(er)

    self.log.debug('Finished attachments', {'id':doc._id})
    callback()
  }
}


Builder.prototype.seed = function(dir) {
  var self = this

  self.log.debug('Seed: %j', dir)
  fs.readdir(dir, function(er, res) {
    if(er)
      return self.die(er)

    var atts = {}
    self.log.debug('Seed files: %j', res)
    async.forEach(res, seed_file, files_seeded)

    function seed_file(name, to_async) {
      var match = name.match(/\.(js|html)$/)
        , type = match && match[1]

      self.log.debug('seed_file: %j', name)

      if(!type)
        return to_async()

      types = {js:'application/javascript', html:'text/html'}
      type = types[type]

      fs.readFile(dir+'/'+name, function(er, body) {
        if(er)
          return to_async(er)

        var data = body.toString('base64')
        atts[name] = { 'content_type':type, 'data':data }
        return to_async()
      })
    }

    function files_seeded(er) {
      if(er)
        self.die(er)

      self.log.debug('Attach seed files: %j', Object.keys(atts))
      txn({'couch':self.couch, 'db':self.db, 'id':'seed', 'create':true}, seed_files, files_seeded)

      function seed_files(doc, to_txn) {
        doc._attachments = doc._attachments || {}
        Object.keys(atts).forEach(function(name) {
          doc._attachments[name] = atts[name]
        })

        return to_txn()
      }

      function files_seeded(er) {
        if(er)
          self.die(er)

        self.log.debug('Seed complete')
      }
    }
  })
}

Builder.prototype.stop = function(reason) {
  var self = this

  self.emit('stop', reason)
  self.die()
}

Builder.prototype.die = function(er) {
  var self = this
  if(self.dead)
    return

  self.log.debug('Stopping builder', {'id':self.id})
  if(self.feed)
    self.feed.stop()

  self.dead = true
  self.emit('die', er)
  if(er)
    self.emit('error', er)
}


function mk_markdown_helper(scope, partials, helpers) {
  return function doc_markdown(body, extra) {
    body = GFM.parse(body)
    var template = handlebars.compile(body)
    return template(scope, {'partials':partials, 'helpers':helpers})
  }
}

//
// Utilities
//


function in_list(element, list) {
  for(var i = 0; i < list.length; i++)
    if(element === list[i])
      return true
}

function not_in_list(list) {
  return not_filter
  function not_filter(element) {
    return ! in_list(element, list)
  }
}

}) // defaultable
