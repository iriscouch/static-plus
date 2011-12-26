var fs = require('fs')
  , tap = require('tap')
  , test = tap.test
  , util = require('util')
  , request = require('request')

var couch = require('./couch')
  , api = require('../api')

couch.setup(test)

test('Build to couch', function(t) {
  // TODO
  t.end()
})
