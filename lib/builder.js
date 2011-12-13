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
  self.prep_template(function(er, result) { did('template', er, result) })
  self.prep_output(function(er, result) { did('output', er, result) })
  self.prep_couch(function(er, result) { did('couch', er, result) })

  function did(label, er, result) {
    if(er)
      return self.emit('error', er)
    self.emit(label, result)

    ok[label] = true
    if(ok.template && ok.output && ok.couch) {
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
        return callback(er, self.output)
      })
    }

    else if(stat.isDirectory()) {
      self.log.info('Wiping out directory: ' + self.output)
      rimraf(self.output, {gently:true}, function(er) {
        if(er)
          return callback(er)
        self.log.debug('Cleaned: ' + self.output)
        return callback(null, self.output)
      })
    }

    else
      callback(new Error('Cannot use output location: ' + self.output))
  })
}


Builder.prototype.prep_couch = function(callback) {
  var self = this;

  assert.ok(self.couch, 'Must set .couch to a CouchDB database URL')
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

//var path = require('path')
//  , http = require('http')
//  , fs = require('fs')
//  , filed = require('filed')
//  , follow = require('follow')
//  , request = require('request').defaults({json:true})
//  , handlebars = require('./handlebars')
//  , build = path.join(__dirname, 'build')
//  , registry = 'http://isaacs.iriscouch.com:5984/registry'
//  , template = fs.readFileSync(path.join(__dirname, 'package.html')).toString()
//  , port = process.env.NPMJSPORT || 8000
//  ;
//
//  
//try {
//  fs.mkdirSync(build, 0755)
//} catch(e) {
//  // already there most likely
//}
//
//http.createServer(function (req, resp) {
//  var f = filed(path.join(build, req.url.slice(1)))
//  req.pipe(f)
//  f.pipe(resp)
//})
//.listen(port)
//
//var follower = follow(registry, function(error, change) {
//  request(registry + '/' + encodeURIComponent(change.id), function (e, resp, doc) {
//    if (resp.statusCode !== 200) return // most likely deleted
//    var f = filed(path.join(build, change.id+'.html'))
//    f.write(handlebars.compile(template)(doc))
//    f.end()
//    console.log(doc)
//  })
//})
//
//// while debugging only generate a few docs
//follower.limit = 2 
//follower.since = 4000

}) // defaultable
