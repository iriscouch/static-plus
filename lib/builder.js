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

  self.template = DEFS.template;
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

  var ok = { template:false, output:false, couch:false }
  self.prep_template(did('template'))
  self.prep_output(did('output'))
  self.prep_couch(did('couch'))

  function did(label) {
    return prep_handler
    function prep_handler(er, result) {
      if(er)
        return self.emit('error', er)
      self.emit(label, result)

      ok[label] = true
      if(ok.template && ok.output && ok.couch) {
        self.started = true
        self.fetch()
      }
    }
  }
}


Builder.prototype.prep_output = function(callback) {
  var self = this;
}


Builder.prototype.prep_couch = function(callback) {
  var self = this;
}


Builder.prototype.prep_template = function(callback) {
  var self = this;

  console.error('self.template = ' + lib.I(self.template))
  assert.ok(self.template, 'Must set .template to a filename or function')
  assert.ok(typeof self.template == 'function' || typeof self.template == 'string',
            'Unknown template type: ' + typeof self.template)

  if(typeof self.template == 'function')
    callback(null, self.template)

  else if(typeof self.template == 'string')
    fs.readFile(self.template, function(er, body) {
      if(er)
        return callback(er)

      self.template = handlebars.compile(template)
      self.log.debug(template.toString())
      return callback(null, self.template)
    })
}
