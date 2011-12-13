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
  , 'template' : null
  , 'output'   : null
  , 'source'   : null
  }, function(module, exports, DEFS, require) {

module.exports = Builder


var fs = require('fs')
  , util = require('util')
  , events = require('events')
  , follow = require('follow')
  , rimraf = require('rimraf')
  , assert = require('assert')
  , request = require('request')
  , handlebars = require('handlebars')

var lib = require('../lib')


util.inherits(Builder, events.EventEmitter)
function Builder () {
  var self = this;
  self.log = lib.getLogger('builder')

  self.template = DEFS.template
  self.output   = DEFS.output
  self.source   = DEFS.source

  self.started = false;

  if(DEFS.autostart) {
    self.log.debug('Autostart')
    self.start()
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
    self.log.debug('did: ' + label)
    if(er)
      return self.emit('error', er)
    self.emit(label, result)

    ok[label] = true
    if(ok.template && ok.output && ok.source) {
      self.log.debug('Prep done; starting')
      self.started = true
      self.emit('start')
      self.fetch()
    }
  }
}


Builder.prototype.prep_output = function(callback) {
  var self = this;

  assert.ok(self.output, 'Must set .output to a directory name')

  fs.lstat(self.output, function(er, stat) {
    if(er && er.code != 'ENOENT')
      return callback(er)

    else if(er && er.code == 'ENOENT') {
      self.log.debug('Creating output directory: ' + self.output)
      fs.mkdir(self.output, 0777, function(er, res) {
        if(er && er.code == 'EEXIST') {
          self.log.warn('Wiping existing output directory: ' + self.output)
          return wipe()
        }

        return callback(er, self.output)
      })
    }

    else if(stat.isDirectory()) {
      self.log.info('Cleaning output directory: ' + self.output)
      wipe()
    }

    else
      callback(new Error('Cannot use output location: ' + self.output))

    function wipe() {
      rimraf(self.output, {gently:true}, function(er) {
        if(er)
          return callback(er)
        self.log.debug('Cleaned: ' + self.output)
        return callback(null, self.output)
      })
    }
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
}
