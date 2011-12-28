var fs = require('fs')
  , tap = require('tap')
  , test = tap.test
  , util = require('util')
  , request = require('request')

var couch = require('./couch')
  , api = require('../api')

couch.setup(test)

test('Build to couch', function(t) {
  t.ok(couch.rtt(), 'The request duration should be known')

  var builder = new api.Builder
  builder.target = couch.DB + '/mysite'
  builder.page('', 'Hello, world')
  //builder.page('jason', 'Hello, Jason')
  builder.deploy()

  var result = null
  builder.on('deploy', function(dep) { result = dep })

  setTimeout(check_deploy, couch.rtt())
  function check_deploy() {
    console.dir(result)
    t.ok(result, 'Builder deployed')
    t.end()
  }
})
