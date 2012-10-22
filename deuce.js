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
  , 'template_name': 'page'
  , 'push_wait' : 500 // milliseconds
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
var mime = require('mime')
var util = require('util')
var less = require('less')
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
  self.bounce_prefix     = null

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

  self.caught_up = 0
}


Builder.prototype.run = function(up_to, callback) {
  var self = this

  if(typeof up_to != 'string' || typeof callback != 'function')
    up_to = null

  self.prep()
  self.on('prep', function() {
    if(up_to == 'prep')
      return callback()

    self.set_config()
    self.on('config', function() {
      if(up_to == 'config')
        return callback()

      self.prep_db()
      self.on('db', function() {
        if(up_to == 'db')
          return callback()

        self.ddoc()
        self.on('ddoc', function() {
          if(up_to == 'ddoc')
            return callback()

          self.follow()
        })
      })
    })
  })
}


Builder.prototype.normalize = function() {
  var self = this

  self.couch = self.couch.replace(/\/+$/, '')
}

Builder.prototype.prep = function() {
  var self = this
  self.normalize()

  self.prep_couch()
  self.once('couch', function() {
    self.prep_session()
    self.once('session', function() {
      self.fixed('prep')
    })
  })
}

Builder.prototype.prep_couch = function() {
  var self = this

  self.log.debug('Prepare couch: %s', self.couch)
  request({'url':self.couch, 'json':true}, function(er, res) {
    if(er)
      return self.die(er)

    if(res.statusCode != 200 || res.body.couchdb != 'Welcome')
      return self.die(new Error('Bad CouchDB url: ' + self.couch))

    self.fixed('couch')
  })
}

Builder.prototype.prep_session = function() {
  var self = this

  var session = self.couch + '/_session'
  self.log.debug('Check session: %s', session)
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

    self.fixed('session', res.body)
  })
}


Builder.prototype.set_config = function() {
  var self = this

  var config = [ [ 'httpd' , 'secure_rewrites', 'false' ]
               , [ 'vhosts', self.staging_prefix    + self.hostname, '/'+self.db+'/_design/'+DEFS.staging   +'/_rewrite' ]
               , [ 'vhosts', self.production_prefix + self.hostname, '/'+self.db+'/_design/'+DEFS.production+'/_rewrite' ]
               ]

  async.forEach(config, set_config, configs_set)

  function set_config(cfg, to_async) {
    var url = self.couch + '/_config/' + cfg[0] + '/' + cfg[1]
    request.put({'url':url, 'json':cfg[2]}, function(er, res) {
      if(er)
        return to_async(er)
      if(res.statusCode != 200)
        return to_async(new Error('Bad config response: ' + JSON.stringify(res.body)))

      self.log.debug('Set config %s/%s = %j',cfg[0], cfg[1], cfg[2])
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


Builder.prototype.prep_db = function() {
  var self = this

  var url = self.couch + '/' + self.db
  self.log.debug('Create db: %s', url)
  request.put({'url':url, 'json':true}, function(er, res) {
    if(er)
      return self.die(er)

    if(res.statusCode != 201 && res.statusCode != 412)
      return self.die(new Error('Bad DB create response: ' + JSON.stringify(res.body)))

    self.fixed('db')
  })
}


Builder.prototype.ddoc = function() {
  var self = this

  var id = '_design/' + DEFS.staging
  self.log.debug('Create ddoc: %s', id)
  txn({'couch':self.couch, 'db':self.db, 'id':id, 'create':true}, build_ddoc, ddoc_built)

  function build_ddoc(doc, to_txn) {
    var namespace = self.namespace

    doc.static_plus = { 'version'   : package.version
                      , 'created_at': new Date
                      //, 'pages'     : self.pages
                      , 'namespace' : namespace
                      , 'production_prefix': self.production_prefix
                      , 'staging_prefix'   : self.staging_prefix
                      , 'bounce_prefix'    : self.bounce_prefix
                      , 'hostname'         : self.hostname
                      }

    doc.rewrites = []
    doc.rewrites.push({'from':'_db'     , 'to':'../..'})
    doc.rewrites.push({'from':'_db/*'   , 'to':'../../*'})

    doc.rewrites.push({'from':'_couchdb'  , 'to':'../../..'})
    doc.rewrites.push({'from':'_couchdb/*', 'to':'../../../*'})

    doc.rewrites.push({'from':'', 'to':namespace})
    doc.rewrites.push({'from':'*', 'to':namespace+'/*'})

    doc.shows = {}
    doc.shows.bounce = "" + function(doc, req) {
      var production_domain = XXX_pro_XXX
        , path = req.requested_path.join('/')
        , loc = 'https://' + production_domain + '/' + path

      log('Bounce to ' + loc)
      return { 'code':301
             , 'headers': {'location':loc}
             , 'body': 'Moved to: ' + loc + '\r\n'
             }
    }

    doc.shows.bounce = doc.shows.bounce.replace(/XXX_pro_XXX/g, JSON.stringify(self.production_prefix + self.hostname))

    if(! self.is_read_only)
      delete doc.validate_doc_update
    else
      doc.validate_doc_update = "" + function(newDoc, oldDoc, userCtx, secObj) {
        if(~userCtx.roles.indexOf('_admin') || ~userCtx.roles.indexOf('editor'))
          return log('Allow change from ' + userCtx.name)
        throw {'forbidden':'This Static+ database is read-only'}
      }

    doc._attachments = {}
    var attachments = ['request.js']
    async.forEach(attachments, attach_file, files_attached)

    function attach_file(name, to_async) {
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

    self.emit('ddoc')
  }
}


Builder.prototype.follow = function() {
  var self = this;

  var db_url = self.couch + '/' + self.db
  self.log.debug('Follow', {'url':db_url})

  if(self.feed) {
    self.log.debug('Stop old feed')
    self.feed.stop()
    self.caught_up = 0
    self.attachments = {}
  }

  self.feed = new follow.Feed
  self.feed.db = db_url
  self.feed.include_docs = true
  self.feed.inactivity_ms = 1 * 60 * 60 * 1000 // 1 hour

  //self.feed.filter = function(doc) { return ! doc._id.match(/^_design\//) }

  process.nextTick(function() { self.feed.follow() })

  self.feed.on('error' , function(er) {
    self.die(er)
  })

  self.feed.on('catchup', function(seq) {
    self.log.debug('Feed caught up for %j: %d', self.id, seq)
    self.caught_up = seq
    //self.push()
  })

  self.feed.on('change', function(change) {
    self.log.debug('Update %d: %s', change.seq, change.id)
    self.doc(change.doc)

    // If this is the "catch-up" event, or if this is any document update after the catch-up, then publish.
    var is_ddoc = !! change.id.match(/^_design\//)
    if(self.caught_up == change.seq || (self.caught_up && !is_ddoc))
      self.push()
  })
}


Builder.prototype.doc = function(doc) {
  var self = this

  if(doc._deleted)
    return self.log.warn('Ignore deleted doc', {'id':doc._id})

  var match = doc._id.match(/^_design\/(.*)$/)
  if(match) {
    if(match[1] != DEFS.staging)
      return self.log.debug('Ignore foreign ddoc: %j', doc._id)
    else if(!doc.static_plus || !doc.static_plus.promote)
      return self.log.debug('Ignore staging ddoc: %j', doc._id)
    else
      return self.promote(doc)
  }

  self.docs[doc._id] = doc

  var atts = doc._attachments || {}
  for (var name in atts) {
    self.attachments[name] = atts[name]
    self.attachments[name].url = self.couch + '/' + self.db + '/' + encodeURIComponent(doc._id) + '/' + name
  }

  if('path' in doc) {
    doc.path = doc.path.replace(/^\/*/, '')
    self.pages_queue[doc.path] = doc
  }
}


Builder.prototype.promote = function(ddoc) {
  var self = this

  // Set a timestamp of this promotion and copy if that works.
  self.log.debug('Staging ddoc requests promotion: %j', ddoc._id)
  txn({'couch':self.couch, 'db':self.db, 'id':ddoc._id}, mark_promoted, promote_marked)

  function mark_promoted(doc, to_txn) {
    doc.static_plus = doc.static_plus || {}
    doc.static_plus.promoted_at = new Date
    delete doc.static_plus.promote

    self.log.debug('Mark promotion at %j', doc.static_plus.promoted_at)
    return to_txn()
  }

  function promote_marked(er, new_ddoc) {
    if(er)
      return self.die(er)

    self.log.debug('Flagged ddoc for promotion: %s %s', new_ddoc._id, new_ddoc._rev)
    self.copy_to_production(new_ddoc)
  }
}


Builder.prototype.copy_to_production = function(ddoc) {
  var self = this

  self.log.debug('Promote to production: %s %s', ddoc._id, ddoc._rev)
  var pro_id = '_design/' + DEFS.production
    , pro_url = self.couch + '/' + self.db + '/' + encID(pro_id)
    , dev_url = self.couch + '/' + self.db + '/' + encID(ddoc._id) + '?rev' + ddoc._rev

  self.log.debug('Promotion source: %s', dev_url)
  request({'method':'HEAD', 'url':pro_url}, function(er, res) {
    if(er)
      return self.die(er)

    var pro_path = pro_id
    if(res.statusCode == 404)
      self.log.debug('Create new production ddoc')
    else if(res.statusCode != 200)
      return self.die(new Error('Bad response for production ddoc: ' + JSON.stringify(res.body)))
    else
      pro_path += '?rev=' + JSON.parse(res.headers.etag)

    self.log.debug('Promotion target: %s', pro_path)
    var headers = {'destination':pro_path}
    request({'method':'COPY', 'url':dev_url, 'headers':headers, 'json':true}, function(er, res) {
      if(er)
        return self.die(er)

      if(res.statusCode != 201)
        return self.die(new Error('Response '+res.statusCode+' to copy: ' + JSON.stringify(res.body)))

      self.log.info('Promoted staging %s to production %s', ddoc._rev, res.body.rev)
      self.configure_bounce()
    })
  })
}


Builder.prototype.configure_bounce = function() {
  var self = this

  if(typeof self.bounce_prefix != 'string')
    return self.log.debug('No bounce prefix to set')

  var domain = self.bounce_prefix + self.hostname
    , cfg_url = self.couch + '/_config/vhosts/' + domain
    , cfg_val = '/' + self.db + '/' + encID('_design/' + DEFS.production) + '/_show/bounce'

  request.put({'url':cfg_url, 'json':cfg_val}, function(er, res) {
    if(er)
      return self.die(er)

    if(res.statusCode != 200)
      return self.die(new Error('Bad config response: ' + JSON.stringify(res.body)))

    self.log.debug('Set bounce vhost: %s = %s', domain, cfg_val)
  })
}

Builder.prototype.push = function() {
  var self = this
  self.log.debug('Push')

  // All attachments must be known.
  var attachments = Object.keys(self.attachments).map(function(A) { return self.attachments[A] })
    , stubs = attachments.filter(function(A) { return A.stub })
                         //.filter(function(A) { return ! A.is_fetching })

  if(stubs.length == 0) {
    self.log.debug('All stubs fetched, time for the publish run')
    return self.publish()
  }

  self.log.debug('Stubs remaining: %j', stubs.length)
  if(stubs.length == 0)
    return self.publish()
  else
    return async.forEach(stubs, get_stub, stubs_got)

  function get_stub(stub, to_async) {
    self.log.debug('Get stub: %s', stub.url)
    stub.is_fetching = true

    request({'url':stub.url}, function(er, res) {
      if(er)
        return to_async(er)

      if(res.statusCode != 200)
        return to_async(new Error('Bad code '+res.statusCode+' ' + JSON.stringify(res.body)))

      stub.body = res.body
      delete stub.stub
      delete stub.is_fetching

      var template_types = [ 'text/html' ]
      if(!~ template_types.indexOf(stub.content_type))
        self.log.debug('Not a template type', {'type':stub.content_type})
      else {
        self.log.debug('Compile template: %s', stub.content_type)
        stub.handlebars = handlebars.compile(stub.body)
      }

      return to_async()
    })
  }

  function stubs_got(er) {
    if(er)
      return self.die(er)

    self.log.debug('Trigger publish with no more stubs')
    self.publish()
  }
}


Builder.prototype.publish = function() {
  var self = this

  var ddoc_id = '_design/' + DEFS.staging
    , paths = Object.keys(self.pages_queue)

  self.log.debug('Publish time: %d updates', paths.length)

  var new_attachments = self.process_pages_queue()
  //console.warn('new_attachments: %s', util.inspect(new_attachments))

  txn({'couch':self.couch, 'db':self.db, 'id':ddoc_id}, attach_pages, pages_attached)

  function attach_pages(ddoc, to_txn) {
    ddoc._attachments = ddoc._attachments || {}

    // Render each document's page and enqueue it for publishing.

    Object.keys(new_attachments).forEach(function(path) {
      var new_attachment = new_attachments[path]
        , existing = ddoc._attachments[path]

      path = self.namespace + '/' + path
      path = path.replace(/\/+$/, '')

      //self.log.warn('=-=-=-=-=-=-=-=')
      //self.log.warn('Should attach: %s\n%s', path, util.inspect(new_attachment))
      //self.log.warn('_attachments: %j', existing)
      //self.log.warn('=-=-=-=-=-=-=-=')

      if(!existing) {
        self.log.debug('Add attachment: %s', path)
        ddoc._attachments[path] = { 'content_type': new_attachment.content_type
                                  , 'data'        : new Buffer(new_attachment.data).toString('base64')
                                  }
      }

      else
        return to_txn(new Error('Unknown attachment situation: ' + path))
    })

    return to_txn()
  }

  function pages_attached(er) {
    if(er)
      return self.die(er)

    self.log.info('Finish publish')
    self.emit('publish')
  }
}


Builder.prototype.process_pages_queue = function() {
  var self = this

  var result = {}
  Object.keys(self.pages_queue).forEach(function(path) {
    var doc = self.pages_queue[path]
    delete self.pages_queue[path]

    var tmpl_name  = doc.template || DEFS.template_name
      , tmpl_id    = tmpl_name + '.html'
      , attachment = self.attachments[tmpl_id]
      , template   = attachment && attachment.handlebars
      , body       = attachment && attachment.body

    if(!template && !body)
      return self.log.warn('No attachment for template: %j', doc._id)

    result[path] = {}
    result[path].content_type = attachment.content_type
    result[path].data = body

    if(template) {
      // Build the scope for the template.

      // Lowest pri: all docs by id
      var scope = JSON.parse(JSON.stringify(self.docs))

      // Next pri: the contents of this document.
      for (var key in doc)
        scope[key] = JSON.parse(JSON.stringify(doc[key]))

      // Highest pri: The markdown helper.
      delete scope.markdown

      var partials = {}
      Object.keys(self.attachments).forEach(function(name) {
        var att = self.attachments[name]
        name = name.replace(/\..*$/, '')
        partials[name] = att.handlebars || att.body
      })

      var helpers = handlebars_helpers()
      helpers.markdown = mk_markdown_helper(scope, partials, helpers)
      helpers.link     = link_helper
      helpers.button   = button_helper
      helpers.css_class = css_class_helper

      self.log.debug('Run template %s: %s', tmpl_id, doc._id)
      try {
        result[path].data = template(scope, {'partials':partials, 'helpers':helpers})
      } catch (er) {
        self.log.debug('Template error: %s', er.message)
        result[path].data = er.stack + '\n'
        result[path].content_type = 'text/plain'
      }
    } // if(template)
  })

  return result
}


Builder.prototype.seed = function(dir) {
  var self = this
  self.normalize()

  self.log.debug('Seed: %j', dir)
  dir_to_attachments.call(self, dir, self.watch, function(er, atts) {
    if(er)
      return self.die(er)

    self.log.debug('Attach files: %j', Object.keys(atts))
    attach_to_doc(atts, self.couch, self.db, 'seed', function(er) {
      if(er)
        return self.die(er)

      self.log.info('Seed complete: %j', Object.keys(atts))
      self.emit('seed')
    })
  })
}


Builder.prototype.update = function(dir) {
  var self = this

  dir_to_attachments.call(self, dir, self.watch, self.namespace, function(er, atts) {
    if(er)
      return self.die(er)

    var ddoc_id = '_design/' + DEFS.staging
    self.log.debug('Attach updates: %j', Object.keys(atts))
    atts._keep = true
    attach_to_doc(atts, self.couch, self.db, ddoc_id, function(er) {
      if(er)
        return self.die(er)

      self.log.info('Update resources: complete')
    })
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
    if(typeof body == 'object' && typeof extra == 'undefined') {
      extra = body
      body = null
    }

    var opts = (extra && extra.hash) || {}
    if(opts.key)
      body = scope[opts.key]

    if(typeof body != 'string')
      return ''

    body = GFM.parse(body)
    var template = handlebars.compile(body)
    var result = template(scope, {'partials':partials, 'helpers':helpers})

    if(opts.key)
      result = util.format('<div class="edit" data-id=%j data-key=%j>%s</div>', scope._id, opts.key, result)

    return result
  }
}


function link_helper(context) {
  var to = context.hash.to
    , type = context.hash.type || ""

  var link = context.hash.label || context.hash.text // "text" is deprecated.
  if(context.hash.type == 'button')
    link = [ '+' + dashes(link) + '+'
           , '|' + link         + '|'
           , '+' + dashes(link) + '+'
           ].join('<br>')

  return util.format('<a class=%j href="%s">%s</a>', type, context.hash.to, link)
}

function button_helper(context) {
  var lines = boxed(context.hash.label)
    , clas  = context.hash.class || ''
    , label = lines.join('<br>')
    , type = context.hash.type || 'button'

  return util.format('<button type=%j class=%j>%s</button>', type, clas, label)
}


function css_class_helper(data, context) {
  data = data || 'landing'
  return data.replace(/[^\w]/g, '_')
}


function dir_to_attachments(dir, is_watcher, prefix, callback) {
  var self = this

  if(!callback) {
    callback = prefix
    prefix = null
  }

  fs.readdir(dir, function(er, res) {
    if(er)
      return callback(er)

    var atts = {}
    async.forEach(res, prep_file, files_prepped)

    function prep_file(name, to_async) {
      var match = name.match(/\.(js|html|css|less|eot|svg|ttf|woff)$/)
        , extension = match && match[1]
        , type = match && mime.lookup(extension)

      if(extension == 'less')
        type = mime.lookup('foo.css')

      if(!type)
        return to_async()

      fs.readFile(dir+'/'+name, function(er, body) {
        if(er)
          return to_async(er)

        if(extension != 'less')
          done()
        else {
          // Less seems to throw sometimes.
          try {
            less.render(body.toString('utf8'), less_result)
          } catch (er) {
            self.log.error('Less error: %s', er.message)
            less_result(er)
          }
        }

        function less_result(er, css) {
          if(er) {
            self.log.error('LESS error: %s', er.message)
            //return to_async(er)
            css = er.stack || er.message || '<Unknown less error>'
          }

          self.log.debug('Built %s to CSS: %d -> %d bytes', name, body.length, css.length)
          body = new Buffer(css)
          done()
        }

        function done() {
          var data = body.toString('base64')

          name = name.replace(/\.less$/, '.css')
          if(prefix)
            name = prefix + '/' + name

          self.log.debug('Prepared: %s', name)
          atts[name] = { 'content_type':type, 'data':data }
          return to_async(null, atts)
        }
      })
    }

    function files_prepped(er) {
      callback(er, atts)

      if(!is_watcher)
        return

      var events = {}

      fs.watch(dir, {'persistent':true}, function(ev, name) {
        var key = ev + ':' + name
        events[key] = {'ev':ev, 'name':name}

        setTimeout(event_batch, 100)
        function event_batch() {
          var to_do = events
          events = {}

          for (var k in to_do) {
            var ev = to_do[k].ev
              , name = to_do[k].name

            change(ev, name)
          }
        }
      })
    }

    function change(ev, name) {
      if(ev != 'change')
        return self.log.debug('Ignore event: %s %s', ev, name)
      else
        self.log.debug('Watch event %j: %j', ev, name)

      delete atts[name]
      prep_file(name, function(er) {
        if(er)
          throw er // XXX

        name = name.replace(/\.less$/, '.css')
        if(prefix)
          name = prefix + '/' + name

        if(!atts[name])
          return self.log.debug('Name was ignored: %s', name)

        var updates = {'_keep':true}
        updates[name] = atts[name]
        callback(null, updates)
      })
    }
  })
}

function attach_to_doc(atts, couch, db, id, callback) {
  var is_clean = ! atts._keep
  delete atts._keep

  id = encodeURIComponent(id).replace(/^_design%2f/i, '_design/')
  txn({'couch':couch, 'db':db, 'id':id, 'create':true}, seed_files, callback)

  function seed_files(doc, to_txn) {
    if(is_clean)
      doc._attachments = {}
    else
      doc._attachments = doc._attachments || {}

    Object.keys(atts).forEach(function(name) {
      doc._attachments[name] = atts[name]
    })

    return to_txn()
  }
}

//
// Utilities
//

function encID(id) {
  return encodeURIComponent(id).replace(/^_design%2f/i, '_design/')
}

function handlebars_helpers() {
  var result = {}
  Object.keys(handlebars.helpers).forEach(function(key) {
    result[key] = handlebars.helpers[key]
  })
  return result
}


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

function boxed(str) {
  return [ '+' + dashes(str) + '+'
         , '|' + str         + '|'
         , '+' + dashes(str) + '+'
         ]
}

function dashes(str) {
  var result = ''
  for(var i = 0; i < str.length; i++)
    result += '-'
  return result
}

}) // defaultable
